package com.conversionvault.app.storage

import android.content.ContentUris
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
        "Samples",
        "Presets",
        "Workflows",
        "Custom_Modules",
        "Backups",
        "Reports",
        "SH_Scripts"
    )

    private val LEGACY_UNUSED_FOLDERS = listOf(
        "Audio_Extract_Mute",
        "Trim_GIF",
        "Thumbnail_Capturer"
    )

    fun getRootDir(context: Context, customRootPath: String? = null): File {
        val savedRoot = context.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)
            .getString("default_vault_folder", null)
        val chosen = customRootPath?.takeIf { it.isNotBlank() } ?: savedRoot?.takeIf { it.isNotBlank() }
        val preferred = if (chosen != null) {
            File(chosen)
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
        if (!root.exists()) root.mkdirs()
        // Remove empty legacy folders from retired modules without touching any user files
        LEGACY_UNUSED_FOLDERS.forEach { legacy ->
            try {
                val dir = File(root, legacy)
                if (dir.exists() && dir.isDirectory && (dir.listFiles()?.isEmpty() == true)) {
                    dir.delete()
                }
            } catch (_: Throwable) {}
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
    fun resolveNextNumberedSubfolder(baseDir: File): String {
        var idx = 1
        while (File(baseDir, String.format("Batch_Conversion_%02d", idx)).exists() && idx < 999) {
            idx++
        }
        return String.format("Batch_Conversion_%02d", idx)
    }

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

    fun resolveTreeDirPath(uri: Uri): String? {
        return try {
            val treeId = DocumentsContract.getTreeDocumentId(uri) ?: return null
            if ("com.android.externalstorage.documents" == uri.authority) {
                val split = treeId.split(":")
                if (split.size >= 2) {
                    val sub = split[1].trimStart('/')
                    if ("primary".equals(split[0], ignoreCase = true)) {
                        val root = Environment.getExternalStorageDirectory().absolutePath.trimEnd('/')
                        return if (sub.isEmpty()) root else "$root/$sub"
                    } else {
                        return if (sub.isEmpty()) "/storage/${split[0]}" else "/storage/${split[0]}/$sub"
                    }
                }
            }
            null
        } catch (_: Throwable) { null }
    }

    private fun queryRealPathFromMediaStore(
        context: Context,
        contentUri: Uri,
        selection: String? = null,
        selectionArgs: Array<String>? = null
    ): String? {
        val cols = mutableListOf(MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DISPLAY_NAME)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            cols.add(MediaStore.MediaColumns.RELATIVE_PATH)
        }
        try {
            context.contentResolver.query(contentUri, cols.toTypedArray(), selection, selectionArgs, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val dataIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DATA)
                    if (dataIdx >= 0) {
                        val p = cursor.getString(dataIdx)
                        if (!p.isNullOrBlank() && File(p).exists()) return p
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val relIdx = cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
                        val nameIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                        val rel = if (relIdx >= 0) cursor.getString(relIdx) else null
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx) else null
                        if (!rel.isNullOrBlank() && !name.isNullOrBlank()) {
                            val candidate = File(Environment.getExternalStorageDirectory(), "${rel.trimEnd('/')}/$name")
                            if (candidate.exists()) return candidate.absolutePath
                        }
                    }
                }
            }
        } catch (_: Throwable) {}
        return null
    }

    fun resolveInputPath(context: Context, uriOrPath: String): String {
        if (!uriOrPath.startsWith("content://") && !uriOrPath.startsWith("file://")) {
            return uriOrPath
        }
        val uri = Uri.parse(uriOrPath)
        if (uri.scheme == "file") {
            return uri.path ?: uriOrPath
        }

        // 1. DocumentsContract URIs (Internal Storage, Recent, Photos, Videos, Audios, Downloads)
        if (DocumentsContract.isDocumentUri(context, uri)) {
            val docId = DocumentsContract.getDocumentId(uri)
            when (uri.authority) {
                "com.android.externalstorage.documents" -> {
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
                "com.android.providers.media.documents" -> {
                    val split = docId.split(":")
                    if (split.size >= 2) {
                        val type = split[0].lowercase()
                        val mediaId = split[1]
                        val mediaUri = when (type) {
                            "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                            "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                            "audio" -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
                            else -> MediaStore.Files.getContentUri("external")
                        }
                        queryRealPathFromMediaStore(
                            context,
                            mediaUri,
                            "${MediaStore.MediaColumns._ID} = ?",
                            arrayOf(mediaId)
                        )?.let { return it }
                    }
                }
                "com.android.providers.downloads.documents" -> {
                    if (docId.startsWith("raw:")) {
                        val rawPath = docId.removePrefix("raw:")
                        if (File(rawPath).exists()) return rawPath
                    }
                    val numId = docId.removePrefix("msf:").toLongOrNull()
                    if (numId != null) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            queryRealPathFromMediaStore(
                                context,
                                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                                "${MediaStore.MediaColumns._ID} = ?",
                                arrayOf(numId.toString())
                            )?.let { return it }
                        }
                        queryRealPathFromMediaStore(
                            context,
                            MediaStore.Files.getContentUri("external"),
                            "${MediaStore.MediaColumns._ID} = ?",
                            arrayOf(numId.toString())
                        )?.let { return it }
                        try {
                            val dlUri = ContentUris.withAppendedId(Uri.parse("content://downloads/public_downloads"), numId)
                            queryRealPathFromMediaStore(context, dlUri)?.let { return it }
                        } catch (_: Throwable) {}
                    }
                }
            }
        }

        // 2. Direct MediaStore / File-provider _data or RELATIVE_PATH lookup
        queryRealPathFromMediaStore(context, uri)?.let { return it }

        // 3. Google Files / third-party provider URI: match exact DISPLAY_NAME + SIZE in MediaStore.Files
        var displayName = "media_file"
        var fileSize = -1L
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val nIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sIdx = c.getColumnIndex(OpenableColumns.SIZE)
                    if (nIdx >= 0) displayName = c.getString(nIdx) ?: displayName
                    if (sIdx >= 0 && !c.isNull(sIdx)) fileSize = c.getLong(sIdx)
                }
            }
        } catch (_: Throwable) {}

        if (displayName != "media_file" && fileSize > 0L) {
            queryRealPathFromMediaStore(
                context,
                MediaStore.Files.getContentUri("external"),
                "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.SIZE} = ?",
                arrayOf(displayName, fileSize.toString())
            )?.let { return it }
        }

        // 4. Fallback: copy cloud/virtual-only stream to app cache staging file
        val finalName = if (displayName == "media_file") getFileNameFromUri(context, uri) else displayName
        val cacheDir = File(context.cacheDir, "staged_inputs").apply { mkdirs() }
        val stagedFile = resolveNonConflictingFile(
            cacheDir,
            File(finalName).nameWithoutExtension,
            File(finalName).extension
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
        if (retentionDays <= 0) return 0
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
