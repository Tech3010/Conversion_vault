package com.conversionvault.app.storage

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

object VaultStorageManager {

    const val DEFAULT_ROOT_NAME = "ConversionVault"

    val MODULE_SUBFOLDERS = listOf(
        "Vault_Core",
        "Metadata_Modifier",
        "Target_Compressor",
        "Audio_Extract_Mute",
        "Trim_GIF",
        "Thumbnail_Capturer",
        "Samples",
        "Presets",
        "Reports",
        "SH_Scripts"
    )

    fun getRootDir(context: Context, customRootPath: String? = null): File {
        val preferred = if (!customRootPath.isNullOrBlank()) {
            File(customRootPath)
        } else {
            File(Environment.getExternalStorageDirectory(), DEFAULT_ROOT_NAME)
        }
        try {
            if (!preferred.exists()) preferred.mkdirs()
            if (preferred.exists() && preferred.canWrite()) return preferred
        } catch (_: Throwable) {}
        val fallback = File(context.getExternalFilesDir(null) ?: context.filesDir, DEFAULT_ROOT_NAME)
        if (!fallback.exists()) fallback.mkdirs()
        return fallback
    }

    fun ensureVaultFolders(context: Context, customRootPath: String? = null): File {
        val root = getRootDir(context, customRootPath)
        MODULE_SUBFOLDERS.forEach { sub ->
            val dir = File(root, sub)
            if (!dir.exists()) dir.mkdirs()
        }
        return root
    }

    fun getModuleDir(context: Context, moduleName: String, subBucket: String? = null): File {
        val root = ensureVaultFolders(context)
        val safeModule = if (MODULE_SUBFOLDERS.contains(moduleName)) moduleName else "Vault_Core"
        val modDir = File(root, safeModule)
        val target = if (!subBucket.isNullOrBlank()) File(modDir, subBucket) else modDir
        if (!target.exists()) target.mkdirs()
        return target
    }

    /**
     * Enforces universal _1, _2, _3 auto-suffixing across all modules so no existing file is ever overwritten.
     */
    fun resolveNonConflictingFile(dir: File, baseName: String, extension: String): File {
        if (!dir.exists()) dir.mkdirs()
        val cleanExt = extension.trimStart('.')
        val cleanBase = baseName.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "output" }
        var candidate = if (cleanExt.isNotEmpty()) File(dir, "$cleanBase.$cleanExt") else File(dir, cleanBase)
        var counter = 1
        while (candidate.exists()) {
            val suffixed = "${cleanBase}_$counter"
            candidate = if (cleanExt.isNotEmpty()) File(dir, "$suffixed.$cleanExt") else File(dir, suffixed)
            counter++
        }
        return candidate
    }

    fun resolveInputPath(context: Context, uriOrPath: String): String {
        if (!uriOrPath.startsWith("content://") && !uriOrPath.startsWith("file://")) {
            return uriOrPath
        }
        val uri = Uri.parse(uriOrPath)
        if (uri.scheme == "file") {
            return uri.path ?: uriOrPath
        }

        // Try direct DocumentsContract externalstorage mapping when MANAGE_EXTERNAL_STORAGE is active
        if (DocumentsContract.isDocumentUri(context, uri)) {
            val docId = DocumentsContract.getDocumentId(uri)
            if ("com.android.externalstorage.documents" == uri.authority) {
                val split = docId.split(":")
                if (split.size >= 2) {
                    val direct = if ("primary".equals(split[0], ignoreCase = true)) {
                        File(Environment.getExternalStorageDirectory(), split[1])
                    } else {
                        File("/storage/${split[0]}/${split[1]}")
                    }
                    if (direct.exists()) return direct.absolutePath
                }
            }
        }

        // Query MediaStore _data column
        try {
            context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(MediaStore.MediaColumns.DATA)
                    if (idx >= 0) {
                        val p = cursor.getString(idx)
                        if (!p.isNullOrBlank() && File(p).exists()) return p
                    }
                }
            }
        } catch (_: Exception) {}

        // Fallback: copy to app cache staging file
        val displayName = getFileNameFromUri(context, uri)
        val cacheDir = File(context.cacheDir, "staged_inputs").apply { mkdirs() }
        val stagedFile = resolveNonConflictingFile(
            cacheDir,
            File(displayName).nameWithoutExtension,
            File(displayName).extension
        )
        context.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(stagedFile).use { output ->
                input.copyTo(output)
            }
        }
        return stagedFile.absolutePath
    }

    fun getFileNameFromUri(context: Context, uri: Uri): String {
        var name = "media_file"
        try {
            context.contentResolver.query(uri, null, null, null, null)?.use { c: Cursor ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) name = c.getString(idx) ?: name
                }
            }
        } catch (_: Exception) {}
        return name
    }

    fun cleanupExpiredSamples(context: Context, retentionDays: Int = 15): Int {
        val samplesDir = getModuleDir(context, "Samples")
        val cutoffMs = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(retentionDays.toLong())
        var deletedCount = 0
        samplesDir.listFiles()?.forEach { file ->
            if (file.isFile && file.lastModified() < cutoffMs) {
                if (file.delete()) deletedCount++
            }
        }
        return deletedCount
    }

    fun scheduleSampleCleanup(context: Context) {
        val request = PeriodicWorkRequestBuilder<SampleCleanupWorker>(24, TimeUnit.HOURS).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "vault_sample_cleanup",
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }
}

class SampleCleanupWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)
        val days = prefs.getInt("sample_retention_days", 15)
        VaultStorageManager.cleanupExpiredSamples(applicationContext, days)
        return Result.success()
    }
}
