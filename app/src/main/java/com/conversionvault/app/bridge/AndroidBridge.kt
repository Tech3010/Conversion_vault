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
    fun pickFile() {
        pickFiles("single", "*/*")
    }

    @JavascriptInterface
    fun pickMultipleFiles() {
        pickFiles("multi", "*/*")
    }

    @JavascriptInterface
    fun pickFolder() {
        pickFiles("folder", "*/*")
    }

    @JavascriptInterface
    fun copyToClipboard(text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("ConversionVault", text))
    }

    @JavascriptInterface
    fun probeFile(uriOrPath: String): String {
        val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
        val file = File(path)
        val infoSession = FFprobeKit.getMediaInformation(path)
        val info = infoSession.mediaInformation
        return if (info != null) {
            val rawProps = info.allProperties ?: JSONObject()
            val streamsArr = rawProps.optJSONArray("streams") ?: JSONArray()
            var vObj: JSONObject? = null
            var aObj: JSONObject? = null
            var subCount = 0
            for (i in 0 until streamsArr.length()) {
                val s = streamsArr.optJSONObject(i) ?: continue
                val cType = s.optString("codec_type", "")
                if (cType.equals("video", true) && vObj == null) vObj = s
                else if (cType.equals("audio", true) && aObj == null) aObj = s
                else if (cType.equals("subtitle", true)) subCount++
            }

            val fpsStr = vObj?.optString("avg_frame_rate", "")?.ifBlank { vObj.optString("r_frame_rate", "") } ?: ""
            val fpsVal = if (fpsStr.contains("/")) {
                val p = fpsStr.split("/")
                val num = p.getOrNull(0)?.toDoubleOrNull() ?: 0.0
                val den = p.getOrNull(1)?.toDoubleOrNull() ?: 1.0
                if (den > 0.0) num / den else 0.0
            } else {
                fpsStr.toDoubleOrNull() ?: 0.0
            }

            val fmtObj = rawProps.optJSONObject("format") ?: JSONObject()
            val tagsJson = fmtObj.optJSONObject("tags")
            val tagKeys = mutableListOf<String>()
            var hasGps = false
            if (tagsJson != null) {
                val it = tagsJson.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    val v = tagsJson.optString(k, "")
                    if (k.contains("location", true) || k.contains("gps", true)) hasGps = true
                    if (tagKeys.size < 6) tagKeys.add("$k: $v")
                }
            }

            JSONObject().apply {
                put("ok", true)
                put("path", path)
                put("filename", file.name)
                put("format", info.format ?: fmtObj.optString("format_name", "unknown"))
                put("durationSec", info.duration?.toDoubleOrNull() ?: fmtObj.optString("duration", "0").toDoubleOrNull() ?: 0.0)
                put("sizeBytes", info.size?.toLongOrNull() ?: file.length())
                put("bitrate", info.bitrate?.toLongOrNull() ?: fmtObj.optString("bit_rate", "0").toLongOrNull() ?: 0L)
                put("streamCount", streamsArr.length())
                put("subtitleCount", subCount)
                put("videoCodec", vObj?.optString("codec_name", "None")?.ifBlank { "None" } ?: "None")
                put("videoProfile", vObj?.optString("profile", "—")?.ifBlank { "—" } ?: "—")
                put("pixFmt", vObj?.optString("pix_fmt", "—")?.ifBlank { "—" } ?: "—")
                put("width", vObj?.optInt("width", 0) ?: 0)
                put("height", vObj?.optInt("height", 0) ?: 0)
                put("fps", fpsVal)
                put("colorSpace", vObj?.optString("color_space", "—")?.ifBlank { "—" } ?: "—")
                put("audioCodec", aObj?.optString("codec_name", "None")?.ifBlank { "None" } ?: "None")
                put("sampleRate", aObj?.optString("sample_rate", "—")?.ifBlank { "—" } ?: "—")
                put("channels", aObj?.optInt("channels", 0) ?: 0)
                put("audioBitrate", aObj?.optString("bit_rate", "0")?.toLongOrNull() ?: 0L)
                put("hasGps", hasGps)
                put("tagsSummary", if (tagKeys.isEmpty()) "No container metadata tags" else tagKeys.joinToString(" · "))
                put("raw", rawProps)
            }.toString()
        } else {
            JSONObject().apply {
                put("ok", false)
                put("path", path)
                put("filename", file.name)
                put("sizeBytes", if (file.exists()) file.length() else 0L)
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
            if (o.has("theme")) {
                val t = o.getString("theme")
                putString("theme", t)
                activity.runOnUiThread { activity.applySystemBarTheme(t) }
            }
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
        val type = o.optString("type", "video")
        val dir = VaultStorageManager.getModuleDir(context, "Samples")
        val baseName = o.optString("baseName", "sample_test")
        val ext = o.optString("ext", "mp4").trimStart('.')
        val argsTemplate = o.optString("argsTemplate", "")
        val outFile = VaultStorageManager.resolveNonConflictingFile(dir, baseName, ext)

        val finalCmd = if (argsTemplate.isNotBlank()) {
            argsTemplate.replace("{OUTPUT}", "\"${outFile.absolutePath}\"")
        } else {
            "-y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac \"${outFile.absolutePath}\""
        }

        Thread {
            val session = FFmpegKit.execute(finalCmd)
            val ok = ReturnCode.isSuccess(session.returnCode) && outFile.exists() && outFile.length() > 0L
            val res = JSONObject().apply {
                put("ok", ok)
                put("type", type)
                put("name", outFile.name)
                put("path", outFile.absolutePath)
                put("sizeBytes", if (outFile.exists()) outFile.length() else 0L)
                put("error", if (ok) "" else (session.allLogsAsString.takeLast(300)))
            }.toString()
            activity.runOnUiThread {
                activity.evalJsFromBridge("window.onSampleGenerated && window.onSampleGenerated($res);")
            }
        }.start()

        return JSONObject().put("started", true).put("targetPath", outFile.absolutePath).toString()
    }

    @JavascriptInterface
    fun listSamples(): String {
        val dir = VaultStorageManager.getModuleDir(context, "Samples")
        val arr = JSONArray()
        dir.listFiles()
            ?.filter { it.isFile }
            ?.sortedByDescending { it.lastModified() }
            ?.forEach { f ->
                arr.put(JSONObject().apply {
                    put("name", f.name)
                    put("path", f.absolutePath)
                    put("sizeBytes", f.length())
                    put("ext", f.extension.lowercase())
                    put("modifiedAt", f.lastModified())
                })
            }
        return arr.toString()
    }

    @JavascriptInterface
    fun deleteSample(path: String): String {
        val f = File(path)
        val ok = f.exists() && f.delete()
        return JSONObject().put("ok", ok).toString()
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
    fun openFolder(folderPath: String) {
        try {
            val target = if (folderPath.isBlank()) VaultStorageManager.getRootDir(context) else File(folderPath)
            if (!target.exists()) target.mkdirs()
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(
                    FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target),
                    "resource/folder"
                )
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(Intent.createChooser(intent, "Open folder").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            try {
                val pmIntent = context.packageManager.getLaunchIntentForPackage("com.google.android.documentsui")
                    ?: Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                pmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(pmIntent)
            } catch (_: Exception) {}
        }
    }

    @JavascriptInterface
    fun exportReportJson(filename: String, content: String): String {
        val dir = VaultStorageManager.getModuleDir(context, "Reports")
        val base = File(filename).nameWithoutExtension.ifBlank { "probe_report" }
        val target = VaultStorageManager.resolveNonConflictingFile(dir, base, "json")
        target.writeText(content)
        return JSONObject().put("ok", true).put("path", target.absolutePath).toString()
    }

    @JavascriptInterface
    fun setAppState(key: String, value: String) {
        prefs.edit().putString("state_$key", value).apply()
    }

    @JavascriptInterface
    fun getAppState(key: String): String {
        return prefs.getString("state_$key", "") ?: ""
    }

    @JavascriptInterface
    fun navigate(pageFilename: String) {
        activity.runOnUiThread {
            activity.loadUiPage(pageFilename)
        }
    }
}
