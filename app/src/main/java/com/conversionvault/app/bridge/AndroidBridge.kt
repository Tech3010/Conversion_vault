package com.conversionvault.app.bridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import com.conversionvault.app.MainActivity
import com.conversionvault.app.data.JobEntity
import com.conversionvault.app.data.PresetEntity
import com.conversionvault.app.data.VaultDatabase
import com.conversionvault.app.engine.ConversionForegroundService
import com.conversionvault.app.hardware.HardwareProfiler
import com.conversionvault.app.storage.VaultStorageManager
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

class AndroidBridge(
    private val activity: MainActivity
) {
    private val context: Context get() = activity.applicationContext
    private val db: VaultDatabase get() = VaultDatabase.getInstance(context)
    private val prefs get() = context.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun getDeviceTelemetry(): String {
        return HardwareProfiler.collectTelemetry(context).toString()
    }

    @JavascriptInterface
    fun pickFiles(mode: String, mimeFilter: String) {
        activity.runOnUiThread {
            activity.launchPicker(mode, mimeFilter)
        }
    }

    @JavascriptInterface
    fun probeFile(uriOrPath: String): String {
        val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
        val infoSession = FFprobeKit.getMediaInformation(path)
        val info = infoSession.mediaInformation
        return if (info != null) {
            JSONObject().apply {
                put("ok", true)
                put("path", path)
                put("filename", File(path).name)
                put("format", info.format ?: "unknown")
                put("durationSec", info.duration?.toDoubleOrNull() ?: 0.0)
                put("sizeBytes", info.size?.toLongOrNull() ?: File(path).length())
                put("bitrate", info.bitrate?.toLongOrNull() ?: 0L)
                put("raw", info.allProperties ?: JSONObject())
            }.toString()
        } else {
            JSONObject().apply {
                put("ok", false)
                put("path", path)
                put("error", infoSession.failStackTrace ?: "FFprobe failed to read file")
            }.toString()
        }
    }

    @JavascriptInterface
    fun enqueueJob(jobJsonStr: String): String {
        val req = JSONObject(jobJsonStr)
        val id = req.optString("id", UUID.randomUUID().toString())
        val module = req.optString("module", "Vault_Core")
        val mediaType = req.optString("mediaType", "Video")
        val inputPath = VaultStorageManager.resolveInputPath(context, req.getString("inputPath"))
        val inFile = File(inputPath)

        val customSubBucket = req.optString("subBucket", "")
        val customOutDir = req.optString("outputDir", "")
        val outDir = if (customOutDir.isNotBlank()) File(customOutDir).apply { mkdirs() }
        else VaultStorageManager.getModuleDir(context, module, customSubBucket.ifBlank { null })

        val baseName = req.optString("outputBaseName", inFile.nameWithoutExtension).ifBlank { inFile.nameWithoutExtension }
        val ext = req.optString("outputExt", inFile.extension).ifBlank { "mp4" }
        val outFile = VaultStorageManager.resolveNonConflictingFile(outDir, baseName, ext)

        val templateArgs = req.optString("commandArgs", "-y -i {INPUT} -c copy {OUTPUT}")
        val resolvedArgs = templateArgs
            .replace("{INPUT}", "\"${inFile.absolutePath}\"")
            .replace("{OUTPUT}", "\"${outFile.absolutePath}\"")

        val policy = req.optString("originalPolicy", prefs.getString("original_source_policy", "KEEP") ?: "KEEP")
        val durationMs = req.optLong("durationMs", 0L)

        val entity = JobEntity(
            id = id,
            module = module,
            mediaType = mediaType,
            inputPath = inFile.absolutePath,
            outputPath = outFile.absolutePath,
            commandArgs = resolvedArgs,
            status = "QUEUED",
            durationMs = durationMs,
            originalPolicy = policy
        )

        runBlocking { db.jobDao().upsertJob(entity) }

        val svcIntent = Intent(context, ConversionForegroundService::class.java).apply {
            action = ConversionForegroundService.ACTION_START_QUEUE
        }
        ContextCompat.startForegroundService(context, svcIntent)

        return JSONObject().apply {
            put("ok", true)
            put("jobId", id)
            put("outputPath", outFile.absolutePath)
        }.toString()
    }

    @JavascriptInterface
    fun cancelJob(jobId: String): String {
        runBlocking {
            val job = db.jobDao().getJobById(jobId)
            if (job != null) {
                if (job.status == "RUNNING") {
                    val intent = Intent(context, ConversionForegroundService::class.java).apply {
                        action = ConversionForegroundService.ACTION_CANCEL_ACTIVE
                    }
                    context.startService(intent)
                } else if (job.status == "QUEUED") {
                    db.jobDao().upsertJob(job.copy(status = "CANCELLED", updatedAt = System.currentTimeMillis()))
                }
            }
        }
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun getJobs(filterModule: String, filterMediaType: String): String {
        val jobs = runBlocking { db.jobDao().getAllJobs() }
        val arr = JSONArray()
        jobs.filter { job ->
            val modOk = filterModule.isBlank() || filterModule == "ALL" ||
                (filterModule == "CANCELLED" && job.status == "CANCELLED") ||
                job.module.equals(filterModule, ignoreCase = true)
            val mediaOk = filterMediaType.isBlank() || filterMediaType == "ALL" ||
                job.mediaType.equals(filterMediaType, ignoreCase = true)
            modOk && mediaOk
        }.forEach { j ->
            arr.put(JSONObject().apply {
                put("id", j.id)
                put("module", j.module)
                put("mediaType", j.mediaType)
                put("inputPath", j.inputPath)
                put("outputPath", j.outputPath)
                put("status", j.status)
                put("progressPct", j.progressPct)
                put("fps", j.fps)
                put("speed", j.speed)
                put("errorLog", j.errorLog)
                put("createdAt", j.createdAt)
            })
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun deleteJob(jobId: String, deleteOutputFile: Boolean): String {
        runBlocking {
            val job = db.jobDao().getJobById(jobId)
            if (job != null && deleteOutputFile) {
                val f = File(job.outputPath)
                if (f.exists()) f.delete()
            }
            db.jobDao().deleteJob(jobId)
        }
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun clearHistory(deleteFiles: Boolean): String {
        runBlocking {
            if (deleteFiles) {
                db.jobDao().getAllJobs()
                    .filter { it.status in listOf("DONE", "CANCELLED", "FAILED") }
                    .forEach { j -> File(j.outputPath).takeIf { it.exists() }?.delete() }
            }
            db.jobDao().clearFinishedHistory()
        }
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun getPresets(includeDeleted: Boolean): String {
        val list = runBlocking {
            if (includeDeleted) db.presetDao().getDeletedPresets() else db.presetDao().getActivePresets()
        }
        val arr = JSONArray()
        list.forEach { p ->
            arr.put(JSONObject().apply {
                put("id", p.id)
                put("name", p.name)
                put("category", p.category)
                put("codec", p.codec)
                put("container", p.container)
                put("crfOrBitrate", p.crfOrBitrate)
                put("extraFlags", p.extraFlags)
                put("isBuiltIn", p.isBuiltIn)
                put("isDeleted", p.isDeleted)
            })
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun savePreset(presetJsonStr: String): String {
        val o = JSONObject(presetJsonStr)
        val entity = PresetEntity(
            id = o.optString("id", UUID.randomUUID().toString()),
            name = o.getString("name"),
            category = o.optString("category", "Video"),
            codec = o.optString("codec", "libx264"),
            container = o.optString("container", "mp4"),
            crfOrBitrate = o.optString("crfOrBitrate", "18"),
            extraFlags = o.optString("extraFlags", ""),
            isBuiltIn = o.optBoolean("isBuiltIn", false),
            isDeleted = false
        )
        runBlocking { db.presetDao().upsertPreset(entity) }
        return JSONObject().put("ok", true).put("id", entity.id).toString()
    }

    @JavascriptInterface
    fun softDeletePreset(id: String): String {
        runBlocking { db.presetDao().softDeletePreset(id) }
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun restorePreset(id: String): String {
        runBlocking { db.presetDao().restorePreset(id) }
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun exportPresetsJson(): String {
        val dir = VaultStorageManager.getModuleDir(context, "Presets")
        val target = VaultStorageManager.resolveNonConflictingFile(dir, "conversion_vault_presets", "json")
        val json = getPresets(false)
        target.writeText(json)
        return JSONObject().put("ok", true).put("path", target.absolutePath).toString()
    }

    @JavascriptInterface
    fun getSettings(): String {
        return JSONObject().apply {
            put("theme", prefs.getString("theme", "dark"))
            put("defaultVaultFolder", prefs.getString("default_vault_folder", VaultStorageManager.getRootDir(context).absolutePath))
            put("originalSourcePolicy", prefs.getString("original_source_policy", "KEEP"))
            put("autoSuffixCollision", true)
            put("sampleRetentionDays", prefs.getInt("sample_retention_days", 15))
        }.toString()
    }

    @JavascriptInterface
    fun saveSettings(settingsJsonStr: String): String {
        val o = JSONObject(settingsJsonStr)
        prefs.edit().apply {
            if (o.has("theme")) putString("theme", o.getString("theme"))
            if (o.has("defaultVaultFolder")) putString("default_vault_folder", o.getString("defaultVaultFolder"))
            if (o.has("originalSourcePolicy")) putString("original_source_policy", o.getString("originalSourcePolicy"))
            if (o.has("sampleRetentionDays")) putInt("sample_retention_days", o.getInt("sampleRetentionDays"))
        }.apply()
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun exportShellScript(filename: String, content: String): String {
        val dir = VaultStorageManager.getModuleDir(context, "SH_Scripts")
        val base = File(filename).nameWithoutExtension.ifBlank { "vault_batch" }
        val target = VaultStorageManager.resolveNonConflictingFile(dir, base, "sh")
        target.writeText(content)
        return JSONObject().put("ok", true).put("path", target.absolutePath).toString()
    }

    @JavascriptInterface
    fun generateTestSample(presetJsonStr: String): String {
        val o = JSONObject(presetJsonStr)
        val codec = o.optString("codec", "libx264")
        val ext = o.optString("container", "mp4")
        val dir = VaultStorageManager.getModuleDir(context, "Samples")
        val outFile = VaultStorageManager.resolveNonConflictingFile(dir, "sample_${codec}", ext)
        val cmd = "-y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 3 -c:v $codec -c:a aac \"${outFile.absolutePath}\""
        val session = FFmpegKit.execute(cmd)
        val ok = ReturnCode.isSuccess(session.returnCode)
        return JSONObject().apply {
            put("ok", ok)
            put("path", outFile.absolutePath)
            put("sizeBytes", if (outFile.exists()) outFile.length() else 0L)
        }.toString()
    }

    @JavascriptInterface
    fun runIntegrityCheck(uriOrPath: String, deepScan: Boolean): String {
        val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
        val file = File(path)
        val probe = FFprobeKit.getMediaInformation(path)
        val headerOk = probe.mediaInformation != null
        var decodeErrors = 0
        var errorSnippet = ""
        if (deepScan && headerOk) {
            val session = FFmpegKit.execute("-v error -i \"$path\" -f null -")
            val logs = session.allLogsAsString.trim()
            if (!ReturnCode.isSuccess(session.returnCode) || logs.isNotEmpty()) {
                decodeErrors = logs.lines().count { it.isNotBlank() }
                errorSnippet = logs.take(800)
            }
        }
        return JSONObject().apply {
            put("ok", headerOk && decodeErrors == 0)
            put("path", path)
            put("fileSizeBytes", file.length())
            put("headerValid", headerOk)
            put("decodeErrorCount", decodeErrors)
            put("errorSnippet", errorSnippet)
        }.toString()
    }

    @JavascriptInterface
    fun runQuickBenchmark(): String {
        val start = System.nanoTime()
        val session = FFmpegKit.execute("-f lavfi -i testsrc2=size=1280x720:rate=60 -t 0.3 -c:v libx264 -preset ultrafast -f null -")
        val elapsedSec = (System.nanoTime() - start) / 1_000_000_000.0
        val ok = ReturnCode.isSuccess(session.returnCode)
        return JSONObject().apply {
            put("ok", ok)
            put("elapsedSec", elapsedSec)
            put("approxFps", if (elapsedSec > 0) (18.0 / elapsedSec) else 0.0)
        }.toString()
    }

    @JavascriptInterface
    fun openFile(path: String) {
        val file = File(path)
        if (!file.exists()) return
        val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @JavascriptInterface
    fun shareFile(path: String) {
        val file = File(path)
        if (!file.exists()) return
        val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, "Share file").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @JavascriptInterface
    fun navigate(pageFilename: String) {
        activity.runOnUiThread {
            activity.loadUiPage(pageFilename)
        }
    }
}
