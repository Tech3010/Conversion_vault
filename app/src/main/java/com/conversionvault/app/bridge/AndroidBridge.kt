package com.conversionvault.app.bridge

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import androidx.exifinterface.media.ExifInterface
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
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
import com.conversionvault.app.engine.NativePhotoEngine
import com.conversionvault.app.hardware.HardwareProfiler
import com.conversionvault.app.storage.VaultStorageManager
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.io.RandomAccessFile
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch

class AndroidBridge(
    private val activity: MainActivity
) {
    private val context: Context get() = activity.applicationContext
    private val db: VaultDatabase get() = VaultDatabase.getInstance(context)
    private val prefs get() = context.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun checkEngineHealth(): String {
        return try {
            val today = java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date())
            val savedDay = prefs.getString("engine_health_day", "") ?: ""
            val dirty = prefs.getBoolean("engine_health_dirty", false)
            val savedJson = prefs.getString("engine_health_json", "") ?: ""
            if (!dirty && savedDay == today && savedJson.isNotBlank()) {
                try {
                    val cached = JSONObject(savedJson)
                    if (cached.optBoolean("ok", false)) return savedJson
                } catch (_: Throwable) {}
            }
            val ff = FFmpegKit.execute("-version")
            val fp = FFprobeKit.execute("-version")
            val photo = NativePhotoEngine.checkHealth()
            val ffOk = ReturnCode.isSuccess(ff.returnCode)
            val fpOk = ReturnCode.isSuccess(fp.returnCode)
            val photoOk = photo.optBoolean("ok", false)
            val firstLine = (ff.allLogsAsString ?: "").lines().firstOrNull { it.contains("ffmpeg version", true) } ?: "FFmpeg 8.1 GPL"
            val allOk = ffOk && fpOk && photoOk
            val errParts = mutableListOf<String>()
            if (!ffOk) errParts.add("FFmpeg: ${(ff.allLogsAsString ?: "init failed").take(120)}")
            if (!fpOk) errParts.add("FFprobe: ${(fp.allLogsAsString ?: "init failed").take(120)}")
            if (!photoOk) errParts.add("Photo Engine: ${photo.optString("error", "init failed")}")
            val resStr = JSONObject().apply {
                put("ok", allOk)
                put("ffmpegOk", ffOk)
                put("ffprobeOk", fpOk)
                put("photoEngineOk", photoOk)
                put("photoEngineVersion", photo.optString("version", "Skia + Exif + Heif"))
                put("version", firstLine.take(60))
                put("error", errParts.joinToString(" | ").take(260))
                put("checkedDay", today)
            }.toString()
            prefs.edit()
                .putString("engine_health_json", resStr)
                .putString("engine_health_day", today)
                .putBoolean("engine_health_dirty", !allOk)
                .apply()
            resStr
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("ffmpegOk", false)
                put("ffprobeOk", false)
                put("photoEngineOk", false)
                put("version", "Engine Error")
                put("error", "${t.javaClass.simpleName}: ${t.message}" + (t.cause?.let { " | Cause: ${it.javaClass.simpleName}: ${it.message}" } ?: ""))
            }.toString()
        }
    }

    companion object {
        @Volatile
        private var isBenchmarkRunning = false
        private val benchLock = Any()

        fun probeFfmpegEncodersJson(): JSONObject {
            val s = FFmpegKit.execute("-hide_banner -encoders")
            val txt = s.allLogsAsString ?: ""
            val wanted = listOf("libx264", "libx265", "libsvtav1", "libaom-av1", "librav1e", "libvpx-vp9", "av1_mediacodec", "h264_mediacodec", "hevc_mediacodec", "libopus", "aac", "libmp3lame", "flac", "libwebp")
            val found = JSONObject()
            wanted.forEach { enc -> found.put(enc, txt.contains(enc)) }
            return found
        }

        fun runBenchmarkInternal(ctx: Context): String {
            val appCtx = ctx.applicationContext
            val prefs = appCtx.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)
            synchronized(benchLock) {
                if (isBenchmarkRunning) {
                    val cached = prefs.getString("hw_test_json", "") ?: ""
                    if (cached.isNotBlank()) return cached
                }
                isBenchmarkRunning = true
                return try {
                    val maxCores = Runtime.getRuntime().availableProcessors().coerceAtLeast(2)
                    val threads = (prefs.getString("default_threads", "8")?.toIntOrNull() ?: maxCores).coerceIn(1, maxCores)
                    val startNs = System.nanoTime()
                    val session = FFmpegKit.execute("-loglevel error -threads $threads -f lavfi -i testsrc2=size=1920x1080:rate=60 -t 1 -c:v libx264 -preset fast -pix_fmt yuv420p -f null -")
                    val elapsedMs = ((System.nanoTime() - startNs) / 1_000_000L).coerceAtLeast(1L)
                    val ok = ReturnCode.isSuccess(session.returnCode)
                    val fps = if (ok) (60.0 / (elapsedMs / 1000.0)) else 0.0
                    val telemetry = HardwareProfiler.getTelemetry(appCtx, forceRefresh = true)
                    val codecs = telemetry.optJSONObject("codecs") ?: JSONObject()
                    val ffmpegEncoders = try { probeFfmpegEncodersJson() } catch (_: Throwable) { JSONObject() }
                    val measuredFps = String.format(Locale.US, "%.1f", fps).toDouble()
                    val testResult = JSONObject().apply {
                        put("ok", ok)
                        put("fps", measuredFps)
                        put("elapsedMs", elapsedMs)
                        put("threads", threads)
                        put("testedAt", System.currentTimeMillis())
                        put("codecs", codecs)
                        put("ffmpegEncoders", ffmpegEncoders)
                    }
                    if (ok && fps > 0.0) {
                        prefs.edit()
                            .putFloat("bench_fps", fps.toFloat())
                            .putString("hw_test_json", testResult.toString())
                            .apply()
                    }
                    testResult.toString()
                } catch (t: Throwable) {
                    JSONObject().put("ok", false).put("error", t.message ?: "Benchmark failed").toString()
                } finally {
                    isBenchmarkRunning = false
                }
            }
        }
    }

    @JavascriptInterface
    fun getAvailableFfmpegEncoders(): String {
        return try {
            JSONObject().put("ok", true).put("encoders", probeFfmpegEncodersJson()).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Failed").toString()
        }
    }

    @JavascriptInterface
    fun getDeviceTelemetry(): String {
        return HardwareProfiler.getTelemetry(context, forceRefresh = false).toString()
    }

    @JavascriptInterface
    fun runBenchmark(): String {
        return runBenchmarkInternal(context)
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
    fun haptic(kind: String) {
        activity.triggerHaptic(kind)
    }

    @JavascriptInterface
    fun setOledImmersive(enabled: Boolean) {
        activity.setOledImmersive(enabled)
    }

    @JavascriptInterface
    fun getBatteryOptimizationStatus(): String {
        return JSONObject().put("unrestricted", activity.isBatteryUnrestricted()).toString()
    }

    @JavascriptInterface
    fun requestBatteryUnrestricted(): String {
        return try {
            val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Unable to open App Info").toString()
        }
    }

    @JavascriptInterface
    fun copyToClipboard(text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("ConversionVault", text))
    }

    @JavascriptInterface
    fun quickProbeFile(uriOrPath: String): String {
        return try {
            val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
            val file = File(path)
            val ext = file.extension.lowercase(Locale.US)
            val sizeBytes = if (file.exists()) file.length() else 0L

            if (NativePhotoEngine.isImageExtension(ext)) {
                var w = 0
                var h = 0
                var mimeType = "image/$ext"
                try {
                    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.absolutePath, opts)
                    w = opts.outWidth.coerceAtLeast(0)
                    h = opts.outHeight.coerceAtLeast(0)
                    if (!opts.outMimeType.isNullOrBlank()) mimeType = opts.outMimeType
                } catch (_: Throwable) {}
                var cameraModel = ""
                var hasGps = false
                var exifOrient = "Normal (0°)"
                val allTags = JSONObject()
                var aperture = "—"
                var shutter = "—"
                var iso = "—"
                var focalLen = "—"
                var lensModel = "—"
                var dateTaken = "—"
                var software = "—"
                var colorSpaceLbl = "sRGB"
                var gpsCoords = "None"
                try {
                    val ex = ExifInterface(file.absolutePath)
                    val mk = ex.getAttribute(ExifInterface.TAG_MAKE) ?: ""
                    val md = ex.getAttribute(ExifInterface.TAG_MODEL) ?: ""
                    cameraModel = listOf(mk, md).filter { it.isNotBlank() }.joinToString(" ").trim()
                    val oInt = ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                    exifOrient = when (oInt) {
                        ExifInterface.ORIENTATION_ROTATE_90 -> "90° CW"
                        ExifInterface.ORIENTATION_ROTATE_180 -> "180°"
                        ExifInterface.ORIENTATION_ROTATE_270 -> "270° CW"
                        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> "Flipped Horizontal"
                        ExifInterface.ORIENTATION_FLIP_VERTICAL -> "Flipped Vertical"
                        else -> "Normal (0°)"
                    }
                    if (oInt == ExifInterface.ORIENTATION_ROTATE_90 || oInt == ExifInterface.ORIENTATION_ROTATE_270) {
                        val tmp = w; w = h; h = tmp
                    }
                    ex.getAttribute(ExifInterface.TAG_F_NUMBER)?.let { if (it.isNotBlank()) aperture = "f/$it" }
                    ex.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)?.let {
                        val v = it.toDoubleOrNull()
                        shutter = if (v != null && v > 0 && v < 1.0) "1/${Math.round(1.0 / v)}s" else "${it}s"
                    }
                    ex.getAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY)?.let { if (it.isNotBlank()) iso = "ISO $it" }
                    ex.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)?.let {
                        val fl35 = ex.getAttribute(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM)
                        focalLen = if (!fl35.isNullOrBlank()) "${it}mm (${fl35}mm eq.)" else "${it}mm"
                    }
                    val lMk = ex.getAttribute(ExifInterface.TAG_LENS_MAKE) ?: ""
                    val lMd = ex.getAttribute(ExifInterface.TAG_LENS_MODEL) ?: ""
                    val lFull = listOf(lMk, lMd).filter { it.isNotBlank() }.joinToString(" ").trim()
                    if (lFull.isNotBlank()) lensModel = lFull
                    dateTaken = ex.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: ex.getAttribute(ExifInterface.TAG_DATETIME) ?: "—"
                    software = ex.getAttribute(ExifInterface.TAG_SOFTWARE) ?: "—"
                    val cs = ex.getAttributeInt(ExifInterface.TAG_COLOR_SPACE, -1)
                    if (cs == 1) colorSpaceLbl = "sRGB"
                    else if (cs == 65535) colorSpaceLbl = "Uncalibrated / Wide Gamut"

                    val latLong = ex.latLong
                    if (latLong != null) {
                        hasGps = true
                        gpsCoords = String.format(Locale.US, "%.5f, %.5f", latLong[0], latLong[1])
                    } else if (!ex.getAttribute(ExifInterface.TAG_GPS_LATITUDE).isNullOrBlank()) {
                        hasGps = true
                        gpsCoords = "GPS Present"
                    }

                    val exifKeys = listOf(
                        "Make" to ExifInterface.TAG_MAKE,
                        "Model" to ExifInterface.TAG_MODEL,
                        "Lens Make" to ExifInterface.TAG_LENS_MAKE,
                        "Lens Model" to ExifInterface.TAG_LENS_MODEL,
                        "Date Taken" to ExifInterface.TAG_DATETIME_ORIGINAL,
                        "Date Modified" to ExifInterface.TAG_DATETIME,
                        "Exposure Time" to ExifInterface.TAG_EXPOSURE_TIME,
                        "Aperture (F-Number)" to ExifInterface.TAG_F_NUMBER,
                        "ISO" to ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
                        "Focal Length" to ExifInterface.TAG_FOCAL_LENGTH,
                        "35mm Equivalent" to ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
                        "Flash" to ExifInterface.TAG_FLASH,
                        "White Balance" to ExifInterface.TAG_WHITE_BALANCE,
                        "Metering Mode" to ExifInterface.TAG_METERING_MODE,
                        "Exposure Bias" to ExifInterface.TAG_EXPOSURE_BIAS_VALUE,
                        "Color Space" to ExifInterface.TAG_COLOR_SPACE,
                        "Orientation" to ExifInterface.TAG_ORIENTATION,
                        "Software" to ExifInterface.TAG_SOFTWARE,
                        "Artist" to ExifInterface.TAG_ARTIST,
                        "Copyright" to ExifInterface.TAG_COPYRIGHT,
                        "Description" to ExifInterface.TAG_IMAGE_DESCRIPTION,
                        "GPS Latitude" to ExifInterface.TAG_GPS_LATITUDE,
                        "GPS Longitude" to ExifInterface.TAG_GPS_LONGITUDE,
                        "GPS Altitude" to ExifInterface.TAG_GPS_ALTITUDE,
                        "GPS Timestamp" to ExifInterface.TAG_GPS_TIMESTAMP,
                        "GPS Datestamp" to ExifInterface.TAG_GPS_DATESTAMP
                    )
                    exifKeys.forEach { (label, tag) ->
                        val v = ex.getAttribute(tag)
                        if (!v.isNullOrBlank()) allTags.put(label, v)
                    }
                } catch (_: Throwable) {}
                val mp = if (w > 0 && h > 0) String.format(Locale.US, "%.2f MP", (w.toDouble() * h.toDouble()) / 1_000_000.0) else "—"
                return JSONObject().apply {
                    put("ok", true)
                    put("path", path)
                    put("filename", file.name)
                    put("format", ext.uppercase(Locale.US))
                    put("mimeType", mimeType)
                    put("durationSec", 0.0)
                    put("sizeBytes", sizeBytes)
                    put("bitrate", 0L)
                    put("streamCount", 1)
                    put("subtitleCount", 0)
                    put("videoCodec", ext.uppercase(Locale.US))
                    put("videoProfile", "—")
                    put("pixFmt", colorSpaceLbl)
                    put("width", w)
                    put("height", h)
                    put("megapixels", mp)
                    put("fps", 0.0)
                    put("colorSpace", colorSpaceLbl)
                    put("audioCodec", "None")
                    put("sampleRate", "—")
                    put("channels", 0)
                    put("audioBitrate", 0L)
                    put("cameraModel", cameraModel)
                    put("lensModel", lensModel)
                    put("aperture", aperture)
                    put("shutter", shutter)
                    put("iso", iso)
                    put("focalLength", focalLen)
                    put("dateTaken", dateTaken)
                    put("software", software)
                    put("gpsCoords", gpsCoords)
                    put("exifOrientation", exifOrient)
                    put("hasGps", hasGps)
                    put("allTags", allTags)
                    put("tagsCount", allTags.length())
                    put("tagsSummary", if (allTags.length() > 0) "${allTags.length()} EXIF tags detected" else "No EXIF metadata detected")
                }.toString()
            }

            val mmr = MediaMetadataRetriever()
            try {
                mmr.setDataSource(file.absolutePath)
                val durMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val br = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull() ?: 0L
                val fps = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull() ?: 0.0
                val mime = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE) ?: ext
                val sr = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) (mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE) ?: "—") else "—"
                val isAudio = mime.startsWith("audio/", true) || w == 0
                JSONObject().apply {
                    put("ok", true)
                    put("path", path)
                    put("filename", file.name)
                    put("format", ext.uppercase(Locale.US))
                    put("durationSec", durMs / 1000.0)
                    put("sizeBytes", sizeBytes)
                    put("bitrate", br)
                    put("streamCount", if (isAudio) 1 else 2)
                    put("subtitleCount", 0)
                    put("videoCodec", if (isAudio) "None" else ext.uppercase(Locale.US))
                    put("videoProfile", "—")
                    put("pixFmt", "—")
                    put("width", w)
                    put("height", h)
                    put("fps", if (fps > 0.0) fps else if (!isAudio) 30.0 else 0.0)
                    put("colorSpace", "—")
                    put("audioCodec", if (isAudio) ext.uppercase(Locale.US) else "AAC")
                    put("sampleRate", sr)
                    put("channels", if (isAudio) 2 else 0)
                    put("audioBitrate", if (isAudio) br else 0L)
                    put("hasGps", false)
                    put("tagsSummary", "MIME: $mime")
                }.toString()
            } finally {
                try { mmr.release() } catch (_: Throwable) {}
            }
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
    }

    @JavascriptInterface
    fun deepInspectFile(uriOrPath: String): String {
        return try {
            val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
            val file = File(path)
            val ext = file.extension.lowercase(Locale.US)
            val isPhotoExt = NativePhotoEngine.isImageExtension(ext)
            val isAudioExt = ext in setOf("mp3", "flac", "opus", "m4a", "wav", "ogg", "ac3", "aac", "wma", "amr", "aiff", "mka")

            val infoSession = FFprobeKit.getMediaInformation(path)
            val info = infoSession.mediaInformation
            val rawProps = info?.allProperties ?: JSONObject()

            val streamsArr = rawProps.optJSONArray("streams") ?: JSONArray()
            var hasRealVideo = false
            var hasAudio = false
            for (i in 0 until streamsArr.length()) {
                val s = streamsArr.optJSONObject(i) ?: continue
                val cType = s.optString("codec_type", "")
                val disp = s.optJSONObject("disposition")
                val attachedPic = disp?.optInt("attached_pic", 0) ?: 0
                val cName = s.optString("codec_name", "").lowercase(Locale.US)
                if (cType.equals("video", true) && attachedPic != 1) {
                    if (!isPhotoExt && cName !in setOf("mjpeg", "png", "webp", "bmp", "gif", "tiff")) {
                        hasRealVideo = true
                    } else if (!isPhotoExt && !isAudioExt) {
                        hasRealVideo = true
                    }
                } else if (cType.equals("audio", true)) {
                    hasAudio = true
                }
            }

            val mediaKind = when {
                isPhotoExt -> "photo"
                hasRealVideo -> "video"
                isAudioExt || hasAudio -> "audio"
                else -> "video"
            }

            val exifObj = JSONObject()
            if (mediaKind == "photo") {
                var w = 0
                var h = 0
                var mimeType = "image/$ext"
                var bitmapConfig = "—"
                var colorSpaceName = "sRGB"
                var hasAlpha = ext in setOf("png", "webp", "gif", "avif")
                try {
                    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.absolutePath, opts)
                    w = opts.outWidth.coerceAtLeast(0)
                    h = opts.outHeight.coerceAtLeast(0)
                    if (!opts.outMimeType.isNullOrBlank()) mimeType = opts.outMimeType
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        opts.outConfig?.name?.let { bitmapConfig = it }
                        opts.outColorSpace?.name?.let { colorSpaceName = it }
                    }
                } catch (_: Throwable) {}

                val rawTags = JSONObject()
                var cameraModel = "—"
                var lensModel = "—"
                var aperture = "—"
                var shutterSpeed = "—"
                var iso = "—"
                var focalLength = "—"
                var exposureProgram = "—"
                var exposureBias = "—"
                var meteringMode = "—"
                var whiteBalance = "—"
                var flash = "—"
                var orientation = "Normal (0°)"
                var dateTaken = "—"
                var dateDigitized = "—"
                var software = "—"
                var gpsCoords = "None"
                var hasGps = false

                try {
                    val ex = ExifInterface(file.absolutePath)
                    val mk = ex.getAttribute(ExifInterface.TAG_MAKE) ?: ""
                    val md = ex.getAttribute(ExifInterface.TAG_MODEL) ?: ""
                    val cam = listOf(mk, md).filter { it.isNotBlank() }.joinToString(" ").trim()
                    if (cam.isNotBlank()) cameraModel = cam

                    val lMk = ex.getAttribute(ExifInterface.TAG_LENS_MAKE) ?: ""
                    val lMd = ex.getAttribute(ExifInterface.TAG_LENS_MODEL) ?: ""
                    val lens = listOf(lMk, lMd).filter { it.isNotBlank() }.joinToString(" ").trim()
                    if (lens.isNotBlank()) lensModel = lens

                    ex.getAttribute(ExifInterface.TAG_F_NUMBER)?.takeIf { it.isNotBlank() }?.let { aperture = "f/$it" }
                    ex.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)?.takeIf { it.isNotBlank() }?.let {
                        val v = it.toDoubleOrNull()
                        shutterSpeed = if (v != null && v > 0.0 && v < 1.0) "1/${Math.round(1.0 / v)}s" else "${it}s"
                    }
                    ex.getAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY)?.takeIf { it.isNotBlank() }?.let { iso = "ISO $it" }
                    ex.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)?.takeIf { it.isNotBlank() }?.let { fl ->
                        val flNum = if (fl.contains("/")) {
                            val parts = fl.split("/")
                            val a = parts.getOrNull(0)?.toDoubleOrNull() ?: 0.0
                            val b = parts.getOrNull(1)?.toDoubleOrNull() ?: 1.0
                            if (b != 0.0) String.format(Locale.US, "%.1f", a / b) else fl
                        } else fl
                        val fl35 = ex.getAttribute(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM)
                        focalLength = if (!fl35.isNullOrBlank()) "${flNum}mm (${fl35}mm eq.)" else "${flNum}mm"
                    }

                    val epInt = ex.getAttributeInt(ExifInterface.TAG_EXPOSURE_PROGRAM, -1)
                    exposureProgram = when (epInt) {
                        1 -> "Manual"
                        2 -> "Normal Program"
                        3 -> "Aperture Priority"
                        4 -> "Shutter Priority"
                        5 -> "Creative"
                        6 -> "Action"
                        7 -> "Portrait"
                        8 -> "Landscape"
                        else -> "—"
                    }
                    ex.getAttribute(ExifInterface.TAG_EXPOSURE_BIAS_VALUE)?.takeIf { it.isNotBlank() }?.let { exposureBias = "$it EV" }

                    val mmInt = ex.getAttributeInt(ExifInterface.TAG_METERING_MODE, -1)
                    meteringMode = when (mmInt) {
                        1 -> "Average"
                        2 -> "Center-Weighted"
                        3 -> "Spot"
                        4 -> "Multi-Spot"
                        5 -> "Pattern / Multi-Segment"
                        6 -> "Partial"
                        else -> "—"
                    }
                    val wbInt = ex.getAttributeInt(ExifInterface.TAG_WHITE_BALANCE, -1)
                    whiteBalance = when (wbInt) {
                        0 -> "Auto"
                        1 -> "Manual"
                        else -> "—"
                    }
                    val flInt = ex.getAttributeInt(ExifInterface.TAG_FLASH, -1)
                    flash = when {
                        flInt < 0 -> "—"
                        (flInt and 1) == 1 -> "Fired"
                        else -> "Did Not Fire"
                    }

                    val oInt = ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                    orientation = when (oInt) {
                        ExifInterface.ORIENTATION_ROTATE_90 -> "90° CW"
                        ExifInterface.ORIENTATION_ROTATE_180 -> "180°"
                        ExifInterface.ORIENTATION_ROTATE_270 -> "270° CW"
                        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> "Flipped Horizontal"
                        ExifInterface.ORIENTATION_FLIP_VERTICAL -> "Flipped Vertical"
                        else -> "Normal (0°)"
                    }
                    if (oInt == ExifInterface.ORIENTATION_ROTATE_90 || oInt == ExifInterface.ORIENTATION_ROTATE_270) {
                        val tmp = w; w = h; h = tmp
                    }

                    dateTaken = ex.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
                        ?: ex.getAttribute(ExifInterface.TAG_DATETIME) ?: "—"
                    dateDigitized = ex.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED) ?: "—"
                    software = ex.getAttribute(ExifInterface.TAG_SOFTWARE)?.takeIf { it.isNotBlank() } ?: "—"

                    val ll = ex.latLong
                    if (ll != null) {
                        hasGps = true
                        val alt = ex.getAltitude(Double.NaN)
                        val altStr = if (!alt.isNaN()) String.format(Locale.US, " · %.1fm", alt) else ""
                        gpsCoords = String.format(Locale.US, "%.5f, %.5f%s", ll[0], ll[1], altStr)
                    } else {
                        val lat = ex.getAttribute(ExifInterface.TAG_GPS_LATITUDE)
                        if (!lat.isNullOrBlank()) {
                            hasGps = true
                            val lon = ex.getAttribute(ExifInterface.TAG_GPS_LONGITUDE) ?: ""
                            gpsCoords = "$lat $lon".trim()
                        }
                    }

                    val dumpKeys = listOf(
                        ExifInterface.TAG_MAKE, ExifInterface.TAG_MODEL, ExifInterface.TAG_LENS_MAKE,
                        ExifInterface.TAG_LENS_MODEL, ExifInterface.TAG_SOFTWARE, ExifInterface.TAG_ARTIST,
                        ExifInterface.TAG_COPYRIGHT, ExifInterface.TAG_IMAGE_DESCRIPTION, ExifInterface.TAG_USER_COMMENT,
                        ExifInterface.TAG_DATETIME_ORIGINAL, ExifInterface.TAG_DATETIME_DIGITIZED, ExifInterface.TAG_DATETIME,
                        ExifInterface.TAG_SUBSEC_TIME_ORIGINAL, ExifInterface.TAG_OFFSET_TIME_ORIGINAL,
                        ExifInterface.TAG_F_NUMBER, ExifInterface.TAG_EXPOSURE_TIME, ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
                        ExifInterface.TAG_FOCAL_LENGTH, ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
                        ExifInterface.TAG_COLOR_SPACE, ExifInterface.TAG_X_RESOLUTION, ExifInterface.TAG_Y_RESOLUTION
                    )
                    for (tk in dumpKeys) {
                        val v = ex.getAttribute(tk)
                        if (!v.isNullOrBlank()) rawTags.put(tk, v)
                    }
                    if (hasGps) rawTags.put("GPSCoordinates", gpsCoords)
                } catch (_: Throwable) {}

                exifObj.apply {
                    put("width", w)
                    put("height", h)
                    put("mimeType", mimeType)
                    put("bitmapConfig", bitmapConfig)
                    put("colorSpace", colorSpaceName)
                    put("hasAlpha", hasAlpha)
                    put("cameraModel", cameraModel)
                    put("lensModel", lensModel)
                    put("aperture", aperture)
                    put("shutterSpeed", shutterSpeed)
                    put("iso", iso)
                    put("focalLength", focalLength)
                    put("exposureProgram", exposureProgram)
                    put("exposureBias", exposureBias)
                    put("meteringMode", meteringMode)
                    put("whiteBalance", whiteBalance)
                    put("flash", flash)
                    put("orientation", orientation)
                    put("dateTaken", dateTaken)
                    put("dateDigitized", dateDigitized)
                    put("software", software)
                    put("gpsCoords", gpsCoords)
                    put("hasGps", hasGps)
                    put("rawTags", rawTags)
                }
            }

            val devTel = try { HardwareProfiler.collectTelemetry(context) } catch (_: Throwable) { JSONObject() }

            JSONObject().apply {
                put("ok", true)
                put("mediaKind", mediaKind)
                put("path", path)
                put("filename", file.name)
                put("extension", ext)
                put("sizeBytes", if (file.exists()) file.length() else 0L)
                put("lastModified", if (file.exists()) file.lastModified() else 0L)
                put("ffprobe", rawProps)
                put("exif", exifObj)
                put("deviceCodecs", devTel)
            }.toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
    }

    @JavascriptInterface
    fun probeFile(uriOrPath: String): String {
        return try {
        val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
        val file = File(path)
        if (NativePhotoEngine.isImageExtension(file.extension)) {
            val fastPhoto = quickProbeFile(path)
            if (JSONObject(fastPhoto).optBoolean("ok", false)) return fastPhoto
        }
        val infoSession = FFprobeKit.getMediaInformation(path)
        val info = infoSession.mediaInformation
        return if (info != null) {
            val rawProps = info.allProperties ?: JSONObject()
            val streamsArr = rawProps.optJSONArray("streams") ?: JSONArray()
            var vObj: JSONObject? = null
            var bestVPixels = -1L
            var aObj: JSONObject? = null
            var subCount = 0
            for (i in 0 until streamsArr.length()) {
                val s = streamsArr.optJSONObject(i) ?: continue
                val cType = s.optString("codec_type", "")
                if (cType.equals("video", true)) {
                    val px = s.optInt("width", 0).toLong() * s.optInt("height", 0).toLong()
                    if (vObj == null || px > bestVPixels) {
                        vObj = s
                        bestVPixels = px
                    }
                }
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
            val allTags = JSONObject()
            val tagKeys = mutableListOf<String>()
            var hasGps = false
            fun collectTags(obj: JSONObject?, prefix: String = "") {
                if (obj == null) return
                val it = obj.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    val v = obj.optString(k, "")
                    if (v.isBlank()) continue
                    if (k.contains("location", true) || k.contains("gps", true)) hasGps = true
                    val fullK = if (prefix.isBlank()) k else "$prefix.$k"
                    allTags.put(fullK, v)
                    if (tagKeys.size < 6) tagKeys.add("$fullK: $v")
                }
            }
            collectTags(fmtObj.optJSONObject("tags"))
            collectTags(vObj?.optJSONObject("tags"), "video")
            collectTags(aObj?.optJSONObject("tags"), "audio")

            val pixFmt = vObj?.optString("pix_fmt", "—")?.ifBlank { "—" } ?: "—"
            val chromaSub = when {
                pixFmt.contains("444") -> "4:4:4"
                pixFmt.contains("422") -> "4:2:2"
                pixFmt.contains("420") -> "4:2:0"
                pixFmt.contains("rgb", true) || pixFmt.contains("bgr", true) -> "RGB"
                else -> "—"
            }
            val bitDepth = when {
                pixFmt.contains("12") -> "12-bit"
                pixFmt.contains("10") -> "10-bit"
                pixFmt != "—" -> "8-bit"
                else -> "—"
            }
            val vCodecName = vObj?.optString("codec_name", "None")?.ifBlank { "None" } ?: "None"
            val hasBFrames = vObj?.optInt("has_b_frames", -1) ?: -1
            val refs = vObj?.optInt("refs", -1) ?: -1
            val frameStructure = when {
                vObj == null -> "—"
                vCodecName in listOf("prores", "mjpeg", "dnxhd", "png", "rawvideo") -> "Intra-Frame (All-I)"
                hasBFrames == 0 && refs == 1 -> "Intra / Low-Delay GOP"
                hasBFrames >= 0 -> "Inter-Frame (GOP · ${hasBFrames} B-frames)"
                else -> "Inter-Frame (GOP)"
            }
            val vLevelRaw = vObj?.optInt("level", -1) ?: -1
            val vLevelStr = if (vLevelRaw > 0) String.format(Locale.US, "L%.1f", vLevelRaw / 10.0) else "—"
            val fieldOrderRaw = vObj?.optString("field_order", "") ?: ""
            val fieldOrder = when {
                fieldOrderRaw.equals("progressive", true) || fieldOrderRaw.isBlank() -> "Progressive"
                else -> "Interlaced ($fieldOrderRaw)"
            }
            val colorRangeRaw = vObj?.optString("color_range", "") ?: ""
            val colorRange = when (colorRangeRaw.lowercase(Locale.US)) {
                "tv", "mpeg" -> "TV Limited (16–235)"
                "pc", "jpeg" -> "PC Full (0–255)"
                else -> if (colorRangeRaw.isBlank()) "—" else colorRangeRaw
            }
            val chaptersArr = rawProps.optJSONArray("chapters")

            JSONObject().apply {
                put("ok", true)
                put("path", path)
                put("filename", file.name)
                put("format", info.format ?: fmtObj.optString("format_name", "unknown"))
                put("formatLongName", fmtObj.optString("format_long_name", "—"))
                put("startTime", fmtObj.optString("start_time", "0.0s"))
                put("durationSec", info.duration?.toDoubleOrNull() ?: fmtObj.optString("duration", "0").toDoubleOrNull() ?: 0.0)
                put("sizeBytes", info.size?.toLongOrNull() ?: file.length())
                put("bitrate", info.bitrate?.toLongOrNull() ?: fmtObj.optString("bit_rate", "0").toLongOrNull() ?: 0L)
                put("streamCount", streamsArr.length())
                put("subtitleCount", subCount)
                put("chapterCount", chaptersArr?.length() ?: 0)
                put("videoCodec", vCodecName)
                put("videoCodecLong", vObj?.optString("codec_long_name", "—") ?: "—")
                put("videoProfile", vObj?.optString("profile", "—")?.ifBlank { "—" } ?: "—")
                put("videoLevel", vLevelStr)
                put("pixFmt", pixFmt)
                put("chromaSubsampling", chromaSub)
                put("chromaLocation", vObj?.optString("chroma_location", "—")?.ifBlank { "—" } ?: "—")
                put("bitDepth", bitDepth)
                put("frameStructure", frameStructure)
                put("hasBFrames", hasBFrames)
                put("refs", refs)
                put("fieldOrder", fieldOrder)
                put("nbFrames", vObj?.optString("nb_frames", "—")?.ifBlank { "—" } ?: "—")
                put("timeBase", vObj?.optString("time_base", "—")?.ifBlank { "—" } ?: "—")
                put("sar", vObj?.optString("sample_aspect_ratio", "—")?.ifBlank { "—" } ?: "—")
                put("dar", vObj?.optString("display_aspect_ratio", "—")?.ifBlank { "—" } ?: "—")
                put("videoBitrate", vObj?.optString("bit_rate", "0")?.toLongOrNull() ?: 0L)
                put("width", vObj?.optInt("width", 0) ?: 0)
                put("height", vObj?.optInt("height", 0) ?: 0)
                put("fps", fpsVal)
                put("colorSpace", vObj?.optString("color_space", "—")?.ifBlank { "—" } ?: "—")
                put("colorTransfer", vObj?.optString("color_transfer", "—")?.ifBlank { "—" } ?: "—")
                put("colorPrimaries", vObj?.optString("color_primaries", "—")?.ifBlank { "—" } ?: "—")
                put("colorRange", colorRange)
                put("audioCodec", aObj?.optString("codec_name", "None")?.ifBlank { "None" } ?: "None")
                put("audioCodecLong", aObj?.optString("codec_long_name", "—") ?: "—")
                put("audioProfile", aObj?.optString("profile", "—")?.ifBlank { "—" } ?: "—")
                put("audioSampleFmt", aObj?.optString("sample_fmt", "—")?.ifBlank { "—" } ?: "—")
                put("audioBitsPerSample", aObj?.optInt("bits_per_sample", 0) ?: 0)
                put("channelLayout", aObj?.optString("channel_layout", "—")?.ifBlank { "—" } ?: "—")
                put("sampleRate", aObj?.optString("sample_rate", "—")?.ifBlank { "—" } ?: "—")
                put("channels", aObj?.optInt("channels", 0) ?: 0)
                put("audioBitrate", aObj?.optString("bit_rate", "0")?.toLongOrNull() ?: 0L)
                put("allTags", allTags)
                put("tagsCount", allTags.length())
                var finalW = vObj?.optInt("width", 0) ?: 0
                var finalH = vObj?.optInt("height", 0) ?: 0
                var cameraModel = ""
                var exifOrient = ""
                var gpsCoords = ""
                var dateTaken = ""
                if (NativePhotoEngine.isImageExtension(file.extension)) {
                    try {
                        if (finalW <= 0 || finalH <= 0) {
                            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeFile(file.absolutePath, opts)
                            if (opts.outWidth > 0 && opts.outHeight > 0) {
                                finalW = opts.outWidth
                                finalH = opts.outHeight
                            }
                        }
                        val ex = ExifInterface(file.absolutePath)
                        val mk = ex.getAttribute(ExifInterface.TAG_MAKE) ?: ""
                        val md = ex.getAttribute(ExifInterface.TAG_MODEL) ?: ""
                        cameraModel = listOf(mk, md).filter { it.isNotBlank() }.joinToString(" ").trim()
                        val dtOrig = ex.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: ex.getAttribute(ExifInterface.TAG_DATETIME) ?: ""
                        dateTaken = dtOrig.trim()
                        val ll = ex.latLong
                        if (ll != null) {
                            hasGps = true
                            gpsCoords = String.format(Locale.US, "%.5f, %.5f", ll[0], ll[1])
                        } else {
                            val lat = ex.getAttribute(ExifInterface.TAG_GPS_LATITUDE)
                            if (!lat.isNullOrBlank()) {
                                hasGps = true
                                val lon = ex.getAttribute(ExifInterface.TAG_GPS_LONGITUDE) ?: ""
                                gpsCoords = "$lat $lon".trim()
                            }
                        }
                        val orientInt = ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                        exifOrient = when (orientInt) {
                            ExifInterface.ORIENTATION_ROTATE_90 -> "90° CW"
                            ExifInterface.ORIENTATION_ROTATE_180 -> "180°"
                            ExifInterface.ORIENTATION_ROTATE_270 -> "270° CW"
                            else -> "Normal (0°)"
                        }
                        val lens = ex.getAttribute(ExifInterface.TAG_LENS_MODEL) ?: ""
                        val ap = ex.getAttribute(ExifInterface.TAG_F_NUMBER)?.let { "f/$it" } ?: ""
                        val exp = ex.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)?.toDoubleOrNull()?.let { s ->
                            if (s > 0 && s < 1.0) "1/${Math.round(1.0 / s)}s" else "${s}s"
                        } ?: ""
                        val isoVal = ex.getAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY) ?: ex.getAttribute(ExifInterface.TAG_ISO_SPEED) ?: ""
                        val fl = ex.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)?.let { rawFl ->
                            val pts = rawFl.split("/")
                            if (pts.size == 2 && (pts[1].toDoubleOrNull() ?: 0.0) > 0.0) {
                                String.format(Locale.US, "%.1f mm", (pts[0].toDoubleOrNull() ?: 0.0) / pts[1].toDouble())
                            } else rawFl
                        } ?: ""
                        val sw = ex.getAttribute(ExifInterface.TAG_SOFTWARE) ?: ""
                        val art = ex.getAttribute(ExifInterface.TAG_ARTIST) ?: ""
                        val cpy = ex.getAttribute(ExifInterface.TAG_COPYRIGHT) ?: ""
                        val flashRaw = ex.getAttribute(ExifInterface.TAG_FLASH) ?: ""
                        val wbRaw = ex.getAttribute(ExifInterface.TAG_WHITE_BALANCE) ?: ""
                        if (cameraModel.isNotBlank()) allTags.put("CameraModel", cameraModel)
                        if (lens.isNotBlank()) allTags.put("LensModel", lens)
                        if (ap.isNotBlank()) allTags.put("Aperture", ap)
                        if (exp.isNotBlank()) allTags.put("ShutterSpeed", exp)
                        if (isoVal.isNotBlank()) allTags.put("ISO", isoVal)
                        if (fl.isNotBlank()) allTags.put("FocalLength", fl)
                        if (sw.isNotBlank()) allTags.put("Software", sw)
                        if (art.isNotBlank()) allTags.put("Artist", art)
                        if (cpy.isNotBlank()) allTags.put("Copyright", cpy)
                        if (flashRaw.isNotBlank()) allTags.put("Flash", flashRaw)
                        if (wbRaw.isNotBlank()) allTags.put("WhiteBalance", wbRaw)
                        if (dateTaken.isNotBlank()) allTags.put("DateTimeOriginal", dateTaken)
                        if (gpsCoords.isNotBlank()) allTags.put("GPSCoordinates", gpsCoords)
                        put("lensModel", lens)
                        put("aperture", ap)
                        put("shutter", exp)
                        put("iso", isoVal)
                        put("focalLength", fl)
                        put("software", sw)
                        put("exifOrientation", exifOrient)
                        if (cameraModel.isNotBlank() && tagKeys.none { it.startsWith("Camera:", true) }) {
                            tagKeys.add(0, "Camera: $cameraModel")
                        }
                    } catch (_: Throwable) {}
                }
                put("allTags", allTags)
                put("tagsCount", allTags.length())
                put("gpsCoords", gpsCoords)
                put("dateTaken", dateTaken)
                put("width", finalW)
                put("height", finalH)
                put("cameraModel", cameraModel)
                put("exifOrientation", exifOrient)
                put("hasGps", hasGps)
                put("tagsSummary", if (tagKeys.isEmpty()) "No metadata tags detected" else tagKeys.joinToString(" · "))
                put("raw", rawProps)
            }.toString()
        } else {
            val fallback = quickProbeFile(path)
            if (JSONObject(fallback).optBoolean("ok", false)) fallback else JSONObject().apply {
                put("ok", false)
                put("path", path)
                put("filename", file.name)
                put("sizeBytes", if (file.exists()) file.length() else 0L)
                put("error", infoSession.failStackTrace ?: "FFprobe failed to read file")
            }.toString()
        }
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("path", uriOrPath)
                put("error", "${t.javaClass.simpleName}: ${t.message}")
            }.toString()
        }
    }

    @JavascriptInterface
    fun enqueueJob(jobJsonStr: String): String {
        return try {
        val req = JSONObject(jobJsonStr)
        val id = req.optString("id", UUID.randomUUID().toString())
        val module = req.optString("module", "Vault_Core")
        val mediaType = req.optString("mediaType", "Video")
        val inputPath = VaultStorageManager.resolveInputPath(context, req.getString("inputPath"))
        val inFile = File(inputPath)

        var customSubBucket = req.optString("subBucket", "")
        var customOutDir = req.optString("outputDir", "")
        if (customSubBucket.contains("__AUTO_NUMBERED__")) {
            val nextNum = VaultStorageManager.resolveNextNumberedSubfolder(VaultStorageManager.getModuleDir(context, module, null))
            customSubBucket = customSubBucket.replace("__AUTO_NUMBERED__", nextNum)
        }
        if (customOutDir.contains("__AUTO_NUMBERED__")) {
            val baseParent = File(customOutDir.substringBefore("__AUTO_NUMBERED__").trimEnd('/'))
            val nextNum = VaultStorageManager.resolveNextNumberedSubfolder(baseParent)
            customOutDir = customOutDir.replace("__AUTO_NUMBERED__", nextNum)
        }
        val outDir = if (customOutDir.isNotBlank()) File(customOutDir).apply { mkdirs() }
        else VaultStorageManager.getModuleDir(context, module, customSubBucket.ifBlank { null })

        val defSuffix = prefs.getString("default_suffix_rule", "_converted") ?: "none"
        val suffixStr = if (defSuffix == "_vault" || defSuffix == "_converted") defSuffix else ""
        val rawBase = req.optString("outputBaseName", "").trim()
        val baseName = if (rawBase.isNotBlank()) rawBase else (inFile.nameWithoutExtension + suffixStr)
        val ext = req.optString("outputExt", inFile.extension).ifBlank { "mp4" }
        val outFile = VaultStorageManager.resolveNonConflictingFile(outDir, baseName, ext)

        val templateArgs = req.optString("commandArgs", "-y -i {INPUT} -c copy {OUTPUT}")
        val isNativePhotoCmd = templateArgs.trim().startsWith("NATIVE_PHOTO:")
        val defThreads = prefs.getString("default_threads", "8") ?: "8"
        val logLvl = prefs.getString("log_level", "info") ?: "info"
        val logPrefix = if (!isNativePhotoCmd && !templateArgs.contains("-loglevel")) "-loglevel $logLvl -stats " else ""
        val threadsPrefix = logPrefix + (if (!isNativePhotoCmd && defThreads.toIntOrNull() != null && !templateArgs.contains("-threads")) "-threads $defThreads " else "")
        val resolvedArgs = if (isNativePhotoCmd) {
            templateArgs.trim()
        } else {
            (threadsPrefix + templateArgs)
                .replace("{INPUT}", "\"${inFile.absolutePath}\"")
                .replace("{OUTPUT}", "\"${outFile.absolutePath}\"")
        }

        val policy = req.optString("originalPolicy", prefs.getString("original_source_policy", "keep") ?: "keep")
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
        try {
            ContextCompat.startForegroundService(context, svcIntent)
        } catch (_: Throwable) {
            try { context.startService(svcIntent) } catch (_: Throwable) {}
        }

        JSONObject().apply {
            put("ok", true)
            put("jobId", id)
            put("outputPath", outFile.absolutePath)
        }.toString()
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("error", "${t.javaClass.simpleName}: ${t.message}")
            }.toString()
        }
    }


    private fun checkUnsafeCustomCommand(cmd: String): String? {
        if (cmd.length > 1600) return "Custom command too long"
        if (Regex("\\b(https?|ftps?|rtmps?|rtsp|tcp|udp|srt|smb|sftp)://", RegexOption.IGNORE_CASE).containsMatchIn(cmd)) {
            return "Network URLs are blocked in offline custom modules"
        }
        if (Regex("[;`$\\r\\n]|&&|\\|\\||\\$\\(").containsMatchIn(cmd)) {
            return "Shell chaining characters are blocked"
        }
        if (Regex("(^|\\s)-(filter_script|filter_complex_script|protocol_whitelist)(\\s|$)", RegexOption.IGNORE_CASE).containsMatchIn(cmd)) {
            return "Restricted FFmpeg flag blocked"
        }
        return null
    }

    @JavascriptInterface
    fun enqueueBatchJobs(jobsJsonArrayStr: String): String {
        return try {
            val arr = JSONArray(jobsJsonArrayStr)
            val defThreads = prefs.getString("default_threads", "8") ?: "8"
            val logLvl = prefs.getString("log_level", "info") ?: "info"
            val defPolicy = prefs.getString("original_source_policy", "keep") ?: "keep"
            val reservedPaths = mutableSetOf<String>()
            val numberedCache = mutableMapOf<String, String>()
            val entities = mutableListOf<JobEntity>()
            var firstJobId = ""

            for (i in 0 until arr.length()) {
                val req = arr.optJSONObject(i) ?: continue
                val id = req.optString("id", "").ifBlank { UUID.randomUUID().toString() }
                val module = req.optString("module", "Vault_Core")
                val mediaType = req.optString("mediaType", "Video")
                val inputPath = VaultStorageManager.resolveInputPath(context, req.getString("inputPath"))
                val inFile = File(inputPath)

                var customSubBucket = req.optString("subBucket", "")
                var customOutDir = req.optString("outputDir", "")
                if (customSubBucket.contains("__AUTO_NUMBERED__")) {
                    val modBase = VaultStorageManager.getModuleDir(context, module, null)
                    val nextNum = numberedCache.getOrPut(modBase.absolutePath) { VaultStorageManager.resolveNextNumberedSubfolder(modBase) }
                    customSubBucket = customSubBucket.replace("__AUTO_NUMBERED__", nextNum)
                }
                if (customOutDir.contains("__AUTO_NUMBERED__")) {
                    val baseParent = File(customOutDir.substringBefore("__AUTO_NUMBERED__").trimEnd('/'))
                    val nextNum = numberedCache.getOrPut(baseParent.absolutePath) { VaultStorageManager.resolveNextNumberedSubfolder(baseParent) }
                    customOutDir = customOutDir.replace("__AUTO_NUMBERED__", nextNum)
                }
                val outDir = if (customOutDir.isNotBlank()) File(customOutDir).apply { mkdirs() }
                else VaultStorageManager.getModuleDir(context, module, customSubBucket.ifBlank { null })

                val defSuffix = prefs.getString("default_suffix_rule", "_converted") ?: "none"
                val suffixStr = if (defSuffix == "_vault" || defSuffix == "_converted") defSuffix else ""
                val rawBase = req.optString("outputBaseName", "").trim()
                val baseName = if (rawBase.isNotBlank()) rawBase else (inFile.nameWithoutExtension + suffixStr)
                val ext = req.optString("outputExt", inFile.extension).ifBlank { "mp4" }

                // Prevent two jobs in the same batch from colliding on the same outputPath before files exist
                var outFile = VaultStorageManager.resolveNonConflictingFile(outDir, baseName, ext)
                var suffixIdx = 1
                while (outFile.absolutePath in reservedPaths) {
                    outFile = File(outDir, "${baseName}_${suffixIdx}.${ext}")
                    suffixIdx++
                }
                reservedPaths.add(outFile.absolutePath)

                val templateArgs = req.optString("commandArgs", "-y -i {INPUT} -c copy {OUTPUT}")
                if (module == "Custom_Modules") {
                    val blocked = checkUnsafeCustomCommand(templateArgs)
                    if (blocked != null) return JSONObject().put("ok", false).put("error", "Security Guard: $blocked").toString()
                }
                val isNativePhotoCmd = templateArgs.trim().startsWith("NATIVE_PHOTO:")
                val logPrefix = if (!isNativePhotoCmd && !templateArgs.contains("-loglevel")) "-loglevel $logLvl -stats " else ""
                val threadsPrefix = logPrefix + (if (!isNativePhotoCmd && defThreads.toIntOrNull() != null && !templateArgs.contains("-threads")) "-threads $defThreads " else "")
                val resolvedArgs = if (isNativePhotoCmd) {
                    templateArgs.trim()
                } else {
                    (threadsPrefix + templateArgs)
                        .replace("{INPUT}", "\"${inFile.absolutePath}\"")
                        .replace("{OUTPUT}", "\"${outFile.absolutePath}\"")
                }

                val policy = req.optString("originalPolicy", defPolicy)
                val durationMs = req.optLong("durationMs", 0L)
                val now = System.currentTimeMillis() + i
                entities.add(
                    JobEntity(
                        id = id,
                        module = module,
                        mediaType = mediaType,
                        inputPath = inFile.absolutePath,
                        outputPath = outFile.absolutePath,
                        commandArgs = resolvedArgs,
                        status = "QUEUED",
                        durationMs = durationMs,
                        originalPolicy = policy,
                        createdAt = now,
                        updatedAt = now
                    )
                )
                if (firstJobId.isEmpty()) firstJobId = id
            }

            if (entities.isNotEmpty()) {
                runBlocking {
                    entities.forEach { db.jobDao().upsertJob(it) }
                }
                val svcIntent = Intent(context, ConversionForegroundService::class.java).apply {
                    action = ConversionForegroundService.ACTION_START_QUEUE
                }
                try {
                    ContextCompat.startForegroundService(context, svcIntent)
                } catch (_: Throwable) {
                    try { context.startService(svcIntent) } catch (_: Throwable) {}
                }
            }

            val idArr = JSONArray()
            entities.forEach { idArr.put(it.id) }
            JSONObject().apply {
                put("ok", entities.isNotEmpty())
                put("count", entities.size)
                put("firstJobId", firstJobId)
                put("jobIds", idArr)
                if (entities.isEmpty()) put("error", "No valid files to queue")
            }.toString()
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("error", "${t.javaClass.simpleName}: ${t.message}")
            }.toString()
        }
    }

    @JavascriptInterface
    fun pauseQueue(): String {
        return try {
            runBlocking {
                db.jobDao().getAllJobs().filter { it.status == "RUNNING" }.forEach { j ->
                    db.jobDao().upsertJob(j.copy(status = "PAUSED", updatedAt = System.currentTimeMillis()))
                }
            }
            val i = Intent(context, ConversionForegroundService::class.java).apply {
                action = ConversionForegroundService.ACTION_PAUSE_QUEUE
            }
            try { context.startService(i) } catch (_: Throwable) {}
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Pause failed").toString()
        }
    }

    @JavascriptInterface
    fun resumeQueue(): String {
        return try {
            runBlocking {
                db.jobDao().getAllJobs().filter { it.status == "PAUSED" }.forEach { j ->
                    db.jobDao().upsertJob(j.copy(status = "QUEUED", progressPct = 0, updatedAt = System.currentTimeMillis()))
                }
            }
            val i = Intent(context, ConversionForegroundService::class.java).apply {
                action = ConversionForegroundService.ACTION_RESUME_QUEUE
            }
            try { ContextCompat.startForegroundService(context, i) } catch (_: Throwable) {
                try { context.startService(i) } catch (_: Throwable) {}
            }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Resume failed").toString()
        }
    }

    @JavascriptInterface
    fun resumeJob(jobId: String): String {
        return try {
            runBlocking {
                db.jobDao().getJobById(jobId)?.let { j ->
                    db.jobDao().upsertJob(j.copy(status = "QUEUED", progressPct = 0, errorLog = "", updatedAt = System.currentTimeMillis()))
                }
            }
            val i = Intent(context, ConversionForegroundService::class.java).apply {
                action = ConversionForegroundService.ACTION_RESUME_QUEUE
            }
            try { ContextCompat.startForegroundService(context, i) } catch (_: Throwable) {
                try { context.startService(i) } catch (_: Throwable) {}
            }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Resume failed").toString()
        }
    }

    @JavascriptInterface
    fun resumeBatchJobs(jobIdsJsonArrayStr: String): String {
        return try {
            val arr = JSONArray(jobIdsJsonArrayStr)
            val ids = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val id = arr.optString(i, "")
                if (id.isNotBlank()) ids.add(id)
            }
            if (ids.isNotEmpty()) {
                runBlocking {
                    ids.forEachIndexed { idx, id ->
                        db.jobDao().getJobById(id)?.let { j ->
                            db.jobDao().upsertJob(
                                j.copy(
                                    status = "QUEUED",
                                    progressPct = 0,
                                    errorLog = "",
                                    updatedAt = System.currentTimeMillis() + idx
                                )
                            )
                        }
                    }
                }
                val appStatePrefs = context.getSharedPreferences("vault_app_state", Context.MODE_PRIVATE)
                appStatePrefs.edit()
                    .putString("cv_batch_job_ids", jobIdsJsonArrayStr)
                    .putString("cv_active_job_id", ids.first())
                    .apply()
                val i = Intent(context, ConversionForegroundService::class.java).apply {
                    action = ConversionForegroundService.ACTION_RESUME_QUEUE
                }
                try { ContextCompat.startForegroundService(context, i) } catch (_: Throwable) {
                    try { context.startService(i) } catch (_: Throwable) {}
                }
            }
            JSONObject().put("ok", ids.isNotEmpty()).put("count", ids.size).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Resume batch failed").toString()
        }
    }

    @JavascriptInterface
    fun deleteJobsBatch(jobIdsJsonArrayStr: String, deleteFiles: Boolean): String {
        return try {
            val arr = JSONArray(jobIdsJsonArrayStr)
            var count = 0
            runBlocking {
                for (i in 0 until arr.length()) {
                    val id = arr.optString(i, "")
                    if (id.isBlank()) continue
                    if (deleteFiles) {
                        db.jobDao().getJobById(id)?.let { j ->
                            val outF = File(j.outputPath)
                            if (outF.exists() && outF.absolutePath != File(j.inputPath).absolutePath) {
                                try { outF.delete() } catch (_: Throwable) {}
                            }
                        }
                    }
                    db.jobDao().deleteJob(id)
                    count++
                }
            }
            JSONObject().put("ok", true).put("count", count).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Batch delete failed").toString()
        }
    }

    @JavascriptInterface
    fun cancelAllActiveJobs(): String {
        return try {
            val i = Intent(context, ConversionForegroundService::class.java).apply {
                action = ConversionForegroundService.ACTION_CANCEL_ACTIVE
            }
            try { context.startService(i) } catch (_: Throwable) {}
            runBlocking {
                db.jobDao().getAllJobs().filter { it.status in listOf("RUNNING", "QUEUED", "PAUSED") }.forEach { j ->
                    db.jobDao().upsertJob(j.copy(status = "CANCELLED", updatedAt = System.currentTimeMillis()))
                }
            }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Cancel batch failed").toString()
        }
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
        val jobs = runBlocking {
            val hd = prefs.getInt("history_retention_days", 30)
            if (hd > 0) db.jobDao().purgeExpiredHistoryJobs(System.currentTimeMillis() - hd * 86_400_000L)
            db.jobDao().getAllJobs()
        }
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
                put("commandArgs", j.commandArgs)
                put("durationMs", j.durationMs)
                put("inputSizeBytes", File(j.inputPath).takeIf { it.exists() }?.length() ?: 0L)
                put("outputSizeBytes", File(j.outputPath).takeIf { it.exists() }?.length() ?: 0L)
                put("errorLog", j.errorLog)
                put("createdAt", j.createdAt)
                put("updatedAt", j.updatedAt)
            })
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun getJobById(jobId: String): String {
        val j = runBlocking { db.jobDao().getJobById(jobId) } ?: return "{}"
        return JSONObject().apply {
            put("id", j.id)
            put("module", j.module)
            put("mediaType", j.mediaType)
            put("inputPath", j.inputPath)
            put("outputPath", j.outputPath)
            put("commandArgs", j.commandArgs)
            put("status", j.status)
            put("progressPct", j.progressPct)
            put("fps", j.fps)
            put("speed", j.speed)
            put("durationMs", j.durationMs)
            put("inputSizeBytes", File(j.inputPath).takeIf { it.exists() }?.length() ?: 0L)
            put("outputSizeBytes", File(j.outputPath).takeIf { it.exists() }?.length() ?: 0L)
            put("errorLog", j.errorLog)
            put("createdAt", j.createdAt)
            put("updatedAt", j.updatedAt)
        }.toString()
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

    private fun ensureBuiltInPresetsSeeded() {
        if (prefs.getBoolean("builtins_seeded_v1", false)) return
        try {
            val now = System.currentTimeMillis()
            val defaults = listOf(
                PresetEntity(
                    id = "builtin_h264_alli",
                    name = "H.264 All-I Edit",
                    category = "Video",
                    codec = "libx264",
                    container = "mp4",
                    crfOrBitrate = "15",
                    extraFlags = "{\"desc\":\"Intra-frame editing master for zero-lag timeline scrubbing.\",\"specs\":\".mp4 · libx264 · Intra-Frame (-g 1) · CRF 15 · AAC 256k\",\"cfg\":{\"presetName\":\"H.264 All-I Edit\",\"container\":\"mp4\",\"codec\":\"libx264\",\"rcMode\":\"crf_only\",\"crf\":15,\"maxrate\":45,\"preset\":\"fast\",\"gop\":\"1\",\"bframes\":0,\"fps\":\"original\",\"scale\":\"original\",\"orient\":\"keep\",\"pixfmt\":\"yuv420p\",\"audioCodec\":\"aac\",\"audioBr\":\"256k\",\"meta\":\"wipe\"}}",
                    isBuiltIn = true,
                    isDeleted = false,
                    updatedAt = now + 6
                ),
                PresetEntity(
                    id = "builtin_reels_60fps",
                    name = "60fps Reels HQ",
                    category = "Video",
                    codec = "libx264",
                    container = "mp4",
                    crfOrBitrate = "18",
                    extraFlags = "{\"desc\":\"Instagram Reels compliant bitrate cap with +faststart & EXIF wipe.\",\"specs\":\".mp4 · libx264 · 60fps · CRF 18 · 12M cap · AAC 192k\",\"cfg\":{\"presetName\":\"60fps Reels HQ\",\"container\":\"mp4\",\"codec\":\"libx264\",\"rcMode\":\"crf_cap\",\"crf\":18,\"maxrate\":12,\"preset\":\"slower\",\"gop\":\"auto\",\"bframes\":2,\"fps\":\"60\",\"scale\":\"original\",\"orient\":\"keep\",\"pixfmt\":\"yuv420p\",\"audioCodec\":\"aac\",\"audioBr\":\"192k\",\"meta\":\"wipe\"}}",
                    isBuiltIn = true,
                    isDeleted = false,
                    updatedAt = now + 5
                ),
                PresetEntity(
                    id = "builtin_hevc_10bit",
                    name = "HEVC 10-Bit Archive",
                    category = "Video",
                    codec = "libx265",
                    container = "mkv",
                    crfOrBitrate = "19",
                    extraFlags = "{\"desc\":\"High-efficiency 10-bit archive with Opus audio.\",\"specs\":\".mkv · libx265 · 10-bit · CRF 19 · Opus 192k\",\"cfg\":{\"presetName\":\"HEVC 10-Bit Archive\",\"container\":\"mkv\",\"codec\":\"libx265\",\"rcMode\":\"crf_only\",\"crf\":19,\"maxrate\":20,\"preset\":\"slow\",\"gop\":\"auto\",\"bframes\":3,\"fps\":\"original\",\"scale\":\"original\",\"orient\":\"keep\",\"pixfmt\":\"yuv420p10le\",\"audioCodec\":\"libopus\",\"audioBr\":\"192k\",\"meta\":\"wipe\"}}",
                    isBuiltIn = true,
                    isDeleted = false,
                    updatedAt = now + 4
                ),
                PresetEntity(
                    id = "builtin_opus_192",
                    name = "Opus 192k Transparent",
                    category = "Audio",
                    codec = "opus",
                    container = "opus",
                    crfOrBitrate = "192k",
                    extraFlags = "{\"desc\":\"Transparent high-efficiency Opus audio at 48 kHz stereo.\",\"specs\":\".opus · 192 kbps · 48 kHz · Stereo\",\"cfg\":{\"presetName\":\"Opus 192k Transparent\",\"fmt\":\"opus\",\"br\":\"192k\",\"ar\":\"48000\",\"ch\":\"2\",\"channels\":\"2\",\"filter\":\"none\",\"gain\":\"0dB\",\"speed\":\"1.0\",\"fade\":\"none\",\"trimStart\":\"00:00:00\",\"trimEnd\":\"End\",\"meta\":\"wipe\"}}",
                    isBuiltIn = true,
                    isDeleted = false,
                    updatedAt = now + 3
                ),
                PresetEntity(
                    id = "builtin_aac_loudnorm",
                    name = "Loudnorm AAC (-14 LUFS)",
                    category = "Audio",
                    codec = "m4a",
                    container = "m4a",
                    crfOrBitrate = "192k",
                    extraFlags = "{\"desc\":\"Broadcast-leveled AAC audio normalized to -14 LUFS.\",\"specs\":\".m4a · 192 kbps · EBU R128 Loudnorm\",\"cfg\":{\"presetName\":\"Loudnorm AAC (-14 LUFS)\",\"fmt\":\"m4a\",\"br\":\"192k\",\"ar\":\"48000\",\"ch\":\"2\",\"channels\":\"2\",\"filter\":\"loudnorm\",\"af\":\"loudnorm\",\"gain\":\"0dB\",\"speed\":\"1.0\",\"fade\":\"none\",\"trimStart\":\"00:00:00\",\"trimEnd\":\"End\",\"meta\":\"wipe\"}}",
                    isBuiltIn = true,
                    isDeleted = false,
                    updatedAt = now + 2
                ),
                PresetEntity(
                    id = "builtin_webp_85",
                    name = "WebP Crisp 85%",
                    category = "Image",
                    codec = "webp",
                    container = "webp",
                    crfOrBitrate = "85",
                    extraFlags = "{\"desc\":\"Tiny web-ready photos with EXIF & GPS stripped.\",\"specs\":\".webp · Q85 · Auto-Orient · 4:4:4 · Wipe EXIF\",\"cfg\":{\"presetName\":\"WebP Crisp 85%\",\"fmt\":\"webp\",\"qual\":85,\"scale\":\"original\",\"orient\":\"auto\",\"colorSpace\":\"srgb_444\",\"crop\":\"original\",\"filter\":\"none\",\"brightness\":0,\"meta\":\"wipe\"}}",
                    isBuiltIn = true,
                    isDeleted = false,
                    updatedAt = now + 1
                )
            )
            runBlocking {
                val existingIds = (db.presetDao().getActivePresets() + db.presetDao().getDeletedPresets()).map { it.id }.toSet()
                defaults.forEach { d ->
                    if (d.id !in existingIds) db.presetDao().upsertPreset(d)
                }
            }
            prefs.edit().putBoolean("builtins_seeded_v1", true).apply()
        } catch (_: Throwable) {}
    }

    @Volatile
    private var cachedActivePresetsJson: String? = null
    @Volatile
    private var cachedDeletedPresetsJson: String? = null

    private fun invalidatePresetsCache() {
        cachedActivePresetsJson = null
        cachedDeletedPresetsJson = null
    }

    @JavascriptInterface
    fun getPresets(includeDeleted: Boolean): String {
        val hit = if (includeDeleted) cachedDeletedPresetsJson else cachedActivePresetsJson
        if (hit != null) return hit
        ensureBuiltInPresetsSeeded()
        return try {
            val list = runBlocking {
                if (includeDeleted) {
                    val pd = prefs.getInt("preset_retention_days", 30)
                    if (pd > 0) db.presetDao().purgeExpiredDeletedPresets(System.currentTimeMillis() - pd * 86_400_000L)
                    db.presetDao().getDeletedPresets()
                } else db.presetDao().getActivePresets()
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
            val outStr = arr.toString()
            if (includeDeleted) cachedDeletedPresetsJson = outStr else cachedActivePresetsJson = outStr
            outStr
        } catch (_: Throwable) {
            "[]"
        }
    }

    @JavascriptInterface
    fun savePreset(presetJsonStr: String): String {
        invalidatePresetsCache()
        return try {
            val o = JSONObject(presetJsonStr)
            val resolvedId = o.optString("id", "").ifBlank { UUID.randomUUID().toString() }
            val entity = PresetEntity(
                id = resolvedId,
                name = o.optString("name", "Custom Preset").ifBlank { "Custom Preset" },
                category = o.optString("category", "Video"),
                codec = o.optString("codec", "libx264"),
                container = o.optString("container", "mp4"),
                crfOrBitrate = o.optString("crfOrBitrate", "18"),
                extraFlags = o.optString("extraFlags", ""),
                isBuiltIn = o.optBoolean("isBuiltIn", false),
                isDeleted = false,
                updatedAt = System.currentTimeMillis()
            )
            runBlocking { db.presetDao().upsertPreset(entity) }
            JSONObject().put("ok", true).put("id", entity.id).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
    }

    @JavascriptInterface
    fun softDeletePreset(id: String): String {
        invalidatePresetsCache()
        return try {
            runBlocking { db.presetDao().softDeletePreset(id) }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Delete failed").toString()
        }
    }

    @JavascriptInterface
    fun restorePreset(id: String): String {
        invalidatePresetsCache()
        return try {
            runBlocking { db.presetDao().restorePreset(id) }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Restore failed").toString()
        }
    }

    @JavascriptInterface
    fun permanentlyDeletePreset(id: String): String {
        invalidatePresetsCache()
        return try {
            runBlocking { db.presetDao().permanentlyDeletePreset(id) }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Permanent delete failed").toString()
        }
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
    fun exportSelectedPresetsJson(idsJsonStr: String): String {
        return try {
            val arr = JSONArray(idsJsonStr)
            val wanted = HashSet<String>()
            for (i in 0 until arr.length()) {
                val id = arr.optString(i, "")
                if (id.isNotBlank()) wanted.add(id)
            }
            if (wanted.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "No presets selected").toString()
            }
            val all = JSONArray(getPresets(false))
            val filtered = JSONArray()
            for (i in 0 until all.length()) {
                val o = all.optJSONObject(i) ?: continue
                if (wanted.contains(o.optString("id", ""))) filtered.put(o)
            }
            if (filtered.length() == 0) {
                return JSONObject().put("ok", false).put("error", "No matching presets found").toString()
            }
            val dir = VaultStorageManager.getModuleDir(context, "Presets")
            val target = VaultStorageManager.resolveNonConflictingFile(dir, "conversion_vault_selected_presets", "json")
            target.writeText(filtered.toString(2))
            JSONObject().put("ok", true).put("count", filtered.length()).put("path", target.absolutePath).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Export failed").toString()
        }
    }

    @Volatile
    private var cachedCacheBytes: Long = -1L
    @Volatile
    private var lastCacheScanAt: Long = 0L

    private fun refreshCacheBytesAsync() {
        val now = System.currentTimeMillis()
        if (cachedCacheBytes >= 0L && (now - lastCacheScanAt) < 10_000L) return
        lastCacheScanAt = now
        Thread {
            try {
                val bytes = computeCacheBytes()
                cachedCacheBytes = bytes
                val mb = String.format(Locale.US, "%.2f MB cached temp files", bytes / (1024.0 * 1024.0))
                activity.evalJsFromBridge("(function(){var el=document.getElementById('lbl-cache');if(el)el.textContent='$mb';})();")
            } catch (_: Throwable) {}
        }.start()
    }

    @JavascriptInterface
    fun getSettings(): String {
        refreshCacheBytesAsync()
        return JSONObject().apply {
            put("theme", prefs.getString("theme", "dark"))
            put("defaultVaultFolder", prefs.getString("default_vault_folder", VaultStorageManager.getRootDir(context).absolutePath))
            put("originalSourcePolicy", prefs.getString("original_source_policy", "keep"))
            put("defaultSubfolderStyle", prefs.getString("default_subfolder_style", "none"))
            put("defaultSuffixRule", prefs.getString("default_suffix_rule", "_converted"))
            put("separateByType", prefs.getBoolean("separate_by_type", true))
            put("defaultThreads", prefs.getString("default_threads", "8"))
            put("hwPreference", prefs.getString("hw_preference", "hw_fast"))
            put("logLevel", prefs.getString("log_level", "info"))
            put("thermalGuard", prefs.getBoolean("thermal_guard", true))
            put("keepScreenAwake", prefs.getBoolean("keep_screen_awake", true))
            put("benchFps", prefs.getFloat("bench_fps", 0f).toDouble())
            put("hwTestJson", prefs.getString("hw_test_json", "") ?: "")
            put("cacheSizeBytes", if (cachedCacheBytes >= 0L) cachedCacheBytes else 0L)
            put("defaultMetadataPolicy", prefs.getString("default_metadata_policy", "forensic"))
            put("autoSuffixCollision", true)
            put("sampleRetentionDays", prefs.getInt("sample_retention_days", 15))
            put("presetRetentionDays", prefs.getInt("preset_retention_days", 30))
            put("historyRetentionDays", prefs.getInt("history_retention_days", 30))
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
            if (o.has("defaultSubfolderStyle")) putString("default_subfolder_style", o.getString("defaultSubfolderStyle"))
            if (o.has("defaultSuffixRule")) putString("default_suffix_rule", o.getString("defaultSuffixRule"))
            if (o.has("separateByType")) putBoolean("separate_by_type", o.optBoolean("separateByType", true))
            if (o.has("defaultThreads")) putString("default_threads", o.getString("defaultThreads"))
            if (o.has("hwPreference")) putString("hw_preference", o.getString("hwPreference"))
            if (o.has("logLevel")) putString("log_level", o.getString("logLevel"))
            if (o.has("thermalGuard")) putBoolean("thermal_guard", o.optBoolean("thermalGuard", true))
            if (o.has("keepScreenAwake")) {
                val keepOn = o.optBoolean("keepScreenAwake", true)
                putBoolean("keep_screen_awake", keepOn)
                if (!keepOn) activity.runOnUiThread { activity.applyKeepScreenAwake(false) }
            }
            if (o.has("defaultMetadataPolicy")) putString("default_metadata_policy", o.getString("defaultMetadataPolicy"))
            if (o.has("sampleRetentionDays")) {
                val d = o.getInt("sampleRetentionDays")
                putInt("sample_retention_days", d)
                if (d > 0) {
                    try { VaultStorageManager.cleanupExpiredSamples(context, d) } catch (_: Throwable) {}
                }
            }
            if (o.has("presetRetentionDays")) {
                val d = o.getInt("presetRetentionDays")
                putInt("preset_retention_days", d)
                if (d > 0) {
                    try { runBlocking { db.presetDao().purgeExpiredDeletedPresets(System.currentTimeMillis() - d * 86_400_000L) } } catch (_: Throwable) {}
                }
            }
            if (o.has("historyRetentionDays")) {
                val d = o.getInt("historyRetentionDays")
                putInt("history_retention_days", d)
                if (d > 0) {
                    try { runBlocking { db.jobDao().purgeExpiredHistoryJobs(System.currentTimeMillis() - d * 86_400_000L) } } catch (_: Throwable) {}
                }
            }
        }.apply()
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun deleteSourceFile(path: String): String {
        return try {
            val f = File(path)
            val deleted = if (f.exists() && f.isFile) f.delete() else false
            if (deleted) {
                try {
                    MediaScannerConnection.scanFile(context, arrayOf(f.absolutePath), null, null)
                } catch (_: Throwable) {}
            }
            JSONObject().put("ok", true).put("deleted", deleted).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("deleted", false).put("error", t.message ?: "Delete failed").toString()
        }
    }

    private fun dirSizeBytes(dir: File?): Long {
        if (dir == null || !dir.exists()) return 0L
        var total = 0L
        try {
            dir.listFiles()?.forEach { f ->
                total += if (f.isDirectory) dirSizeBytes(f) else f.length()
            }
        } catch (_: Throwable) {}
        return total
    }

    private fun deleteDirChildren(dir: File?): Long {
        if (dir == null || !dir.exists()) return 0L
        var freed = 0L
        try {
            dir.listFiles()?.forEach { f ->
                if (f.isDirectory) {
                    freed += deleteDirChildren(f)
                    try { f.delete() } catch (_: Throwable) {}
                } else {
                    val sz = f.length()
                    if (try { f.delete() } catch (_: Throwable) { false }) {
                        freed += sz
                    }
                }
            }
        } catch (_: Throwable) {}
        return freed
    }

    private fun computeCacheBytes(): Long {
        var total = dirSizeBytes(context.cacheDir)
        val ext = context.externalCacheDir
        if (ext != null && ext.absolutePath != context.cacheDir.absolutePath) {
            total += dirSizeBytes(ext)
        }
        return total
    }

    @JavascriptInterface
    fun clearCache(): String {
        cachedCacheBytes = 0L
        lastCacheScanAt = System.currentTimeMillis()
        var bytesFreed = 0L
        try {
            bytesFreed += deleteDirChildren(context.cacheDir)
            val ext = context.externalCacheDir
            if (ext != null && ext.absolutePath != context.cacheDir.absolutePath) {
                bytesFreed += deleteDirChildren(ext)
            }
            activity.clearWebViewCache()
        } catch (_: Throwable) {}
        val remaining = computeCacheBytes()
        return JSONObject()
            .put("ok", true)
            .put("bytesFreed", bytesFreed)
            .put("remainingBytes", remaining)
            .toString()
    }

    @JavascriptInterface
    fun exportShellScript(filename: String, content: String): String {
        val dir = VaultStorageManager.getModuleDir(context, "SH_Scripts")
        val base = File(filename).nameWithoutExtension.ifBlank { "vault_batch" }
        val target = VaultStorageManager.resolveNonConflictingFile(dir, base, "sh")
        target.writeText(content)
        return JSONObject().put("ok", true).put("path", target.absolutePath).toString()
    }

    private fun executeFfmpegWithProgress(
        cmd: String,
        expectedDurationMs: Long,
        onTick: (Int, Float, Long) -> Unit
    ): com.arthenica.ffmpegkit.FFmpegSession {
        val latch = CountDownLatch(1)
        var lastTick = 0L
        val session = FFmpegKit.executeAsync(
            cmd,
            { _ -> latch.countDown() },
            { _ -> },
            { stats ->
                val now = System.currentTimeMillis()
                if (now - lastTick >= 150L) {
                    lastTick = now
                    val tMs = stats.time.toLong().coerceAtLeast(0L)
                    val pct = if (expectedDurationMs > 0L) ((tMs.toDouble() / expectedDurationMs.toDouble()) * 100.0).toInt().coerceIn(5, 98) else 50
                    onTick(pct, stats.videoFps, tMs)
                }
            }
        )
        try { latch.await() } catch (_: InterruptedException) {}
        return session
    }

    private fun emitUiProgress(fnName: String, pct: Int, stage: String, detail: String = "") {
        val payload = JSONObject().apply {
            put("pct", pct.coerceIn(0, 100))
            put("stage", stage)
            put("detail", detail)
        }.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        activity.runOnUiThread {
            activity.evalJsFromBridge("window.$fnName && window.$fnName($payload);")
        }
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
            val res = try {
                outFile.parentFile?.mkdirs()
                val durMatch = Regex("-t\\s+(\\d+(?:\\.\\d+)?)").find(finalCmd)
                val targetDurMs = ((durMatch?.groupValues?.getOrNull(1)?.toDoubleOrNull() ?: 3.0) * 1000.0).toLong().coerceAtLeast(1000L)
                emitUiProgress("onSampleProgress", 10, "Initializing FFmpeg lavfi generator...", outFile.name)
                var session = executeFfmpegWithProgress(finalCmd, targetDurMs) { pct, fps, tMs ->
                    val fpsTxt = if (fps > 0f) " · ${fps.toInt()} fps" else ""
                    emitUiProgress("onSampleProgress", pct, "Generating ${ext.uppercase()} sample ($pct%$fpsTxt)...", "${tMs}ms / ${targetDurMs}ms")
                }
                var ok = ReturnCode.isSuccess(session.returnCode) && outFile.exists() && outFile.length() > 0L
                // Automatic fallback if libsvtav1 is unavailable or rejects a parameter -> try libaom-av1, then av1_mediacodec
                if (!ok && finalCmd.contains("libsvtav1")) {
                    if (outFile.exists()) outFile.delete()
                    emitUiProgress("onSampleProgress", 22, "Switching to libaom-av1 encoder fallback...", outFile.name)
                    val fallbackCmd = finalCmd
                        .replace("libsvtav1", "libaom-av1")
                        .replace(Regex("-preset\\s+\\S+"), "-cpu-used 8 -row-mt 1")
                        .replace(Regex("-bf\\s+\\d+"), "")
                        .replace(Regex("-maxrate\\s+\\S+"), "")
                        .replace(Regex("-bufsize\\s+\\S+"), "")
                        .replace(Regex("\\s+"), " ")
                        .trim()
                    session = executeFfmpegWithProgress(fallbackCmd, targetDurMs) { pct, fps, tMs ->
                        val fpsTxt = if (fps > 0f) " · ${fps.toInt()} fps" else ""
                        emitUiProgress("onSampleProgress", pct, "Encoding AV1 (libaom-av1) $pct%$fpsTxt...", "${tMs}ms / ${targetDurMs}ms")
                    }
                    ok = ReturnCode.isSuccess(session.returnCode) && outFile.exists() && outFile.length() > 0L
                    if (!ok && !finalCmd.contains("-still-picture")) {
                        if (outFile.exists()) outFile.delete()
                        emitUiProgress("onSampleProgress", 30, "Trying hardware av1_mediacodec...", outFile.name)
                        val mcCmd = finalCmd
                            .replace("libsvtav1", "av1_mediacodec")
                            .replace(Regex("-crf\\s+\\d+"), "-b:v 6M")
                            .replace(Regex("-preset\\s+\\S+"), "")
                            .replace(Regex("\\s+"), " ")
                            .trim()
                        session = executeFfmpegWithProgress(mcCmd, targetDurMs) { pct, fps, tMs ->
                            val fpsTxt = if (fps > 0f) " · ${fps.toInt()} fps" else ""
                            emitUiProgress("onSampleProgress", pct, "Encoding AV1 (HW) $pct%$fpsTxt...", "${tMs}ms / ${targetDurMs}ms")
                        }
                        ok = ReturnCode.isSuccess(session.returnCode) && outFile.exists() && outFile.length() > 0L
                    }
                }
                // Automatic fallback if libvpx-vp9 fails with 10-bit or profile mismatch -> retry with yuv420p
                if (!ok && finalCmd.contains("libvpx-vp9")) {
                    if (outFile.exists()) outFile.delete()
                    emitUiProgress("onSampleProgress", 25, "Retrying VP9 with compatible 8-bit profile...", outFile.name)
                    val fallbackVp9 = finalCmd
                        .replace("-deadline realtime", "-deadline good -cpu-used 5 -row-mt 1")
                        .replace("yuv420p10le", "yuv420p")
                        .replace("yuv422p", "yuv420p")
                    session = executeFfmpegWithProgress(fallbackVp9, targetDurMs) { pct, fps, tMs ->
                        val fpsTxt = if (fps > 0f) " · ${fps.toInt()} fps" else ""
                        emitUiProgress("onSampleProgress", pct, "Encoding VP9 fallback ($pct%$fpsTxt)...", "${tMs}ms / ${targetDurMs}ms")
                    }
                    ok = ReturnCode.isSuccess(session.returnCode) && outFile.exists() && outFile.length() > 0L
                }
                emitUiProgress("onSampleProgress", 98, if (ok) "Indexing saved sample..." else "Finalizing...", outFile.name)
                if (ok) {
                    try { MediaScannerConnection.scanFile(context, arrayOf(outFile.absolutePath), null, null) } catch (_: Throwable) {}
                }
                try {
                    val mType = when (type.lowercase()) {
                        "audio" -> "Audio"
                        "image" -> "Image"
                        else -> "Video"
                    }
                    runBlocking {
                        db.jobDao().upsertJob(
                            JobEntity(
                                id = UUID.randomUUID().toString(),
                                module = "Sample_Tester",
                                mediaType = mType,
                                inputPath = "lavfi ($mType sample)",
                                outputPath = outFile.absolutePath,
                                commandArgs = finalCmd,
                                status = if (ok) "DONE" else "FAILED",
                                progressPct = if (ok) 100 else 0,
                                errorLog = if (ok) "" else (session.failStackTrace ?: session.allLogsAsString ?: "Sample failed").takeLast(400)
                            )
                        )
                    }
                } catch (_: Throwable) {}
                JSONObject().apply {
                    put("ok", ok)
                    put("type", type)
                    put("name", outFile.name)
                    put("path", outFile.absolutePath)
                    put("sizeBytes", if (outFile.exists()) outFile.length() else 0L)
                    put("error", if (ok) "" else (session.failStackTrace ?: session.allLogsAsString ?: "FFmpeg error").takeLast(300))
                }.toString()
            } catch (t: Throwable) {
                JSONObject().apply {
                    put("ok", false)
                    put("type", type)
                    put("name", outFile.name)
                    put("path", outFile.absolutePath)
                    put("sizeBytes", 0L)
                    put("error", "${t.javaClass.simpleName}: ${t.message}")
                }.toString()
            }
            activity.runOnUiThread {
                val safeRes = res.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
                activity.evalJsFromBridge("window.onSampleGenerated && window.onSampleGenerated($safeRes);")
            }
        }.start()

        return JSONObject().put("started", true).put("targetPath", outFile.absolutePath).toString()
    }

    @JavascriptInterface
    fun listSamples(): String {
        val retDays = prefs.getInt("sample_retention_days", 15)
        if (retDays > 0) { try { VaultStorageManager.cleanupExpiredSamples(context, retDays) } catch (_: Throwable) {} }
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
    fun runIntegrityCheckAsync(uriOrPath: String, deepScan: Boolean): String {
        Thread {
            val res = runIntegrityCheck(uriOrPath, deepScan)
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029")
            activity.runOnUiThread {
                activity.evalJsFromBridge("window.onIntegrityResult && window.onIntegrityResult($res);")
            }
        }.start()
        return JSONObject().put("started", true).toString()
    }

    @JavascriptInterface
    fun runIntegrityCheck(uriOrPath: String, deepScan: Boolean): String {
        val t0 = System.currentTimeMillis()
        return try {
            val path = VaultStorageManager.resolveInputPath(context, uriOrPath)
            val file = File(path)
            val ext = file.extension.lowercase(Locale.US)
            val sizeBytes = if (file.exists()) file.length() else 0L

            if (!file.exists() || sizeBytes <= 0L) {
                return JSONObject().apply {
                    put("ok", false)
                    put("verdict", "CORRUPTED")
                    put("healthScore", 0)
                    put("path", path)
                    put("filename", file.name)
                    put("extension", ext)
                    put("fileSizeBytes", sizeBytes)
                    put("headerValid", false)
                    put("decodeErrorCount", 1)
                    put("summary", "File is missing or 0 bytes (empty).")
                    put("elapsedMs", System.currentTimeMillis() - t0)
                }.toString()
            }

            emitUiProgress("onIntegrityProgress", 8, "Reading binary magic bytes & EOF tail...", file.name)
            // 1. Read first 64 & last 64 bytes for magic signature & null-tail / EOF checks
            val headBytes = ByteArray(minOf(64L, sizeBytes).toInt())
            val tailBytes = ByteArray(minOf(64L, sizeBytes).toInt())
            RandomAccessFile(file, "r").use { raf ->
                raf.readFully(headBytes)
                raf.seek(maxOf(0L, sizeBytes - tailBytes.size))
                raf.readFully(tailBytes)
            }
            val safePath = path.replace("\"", "\\\"")
            val isUncompressedAudio = ext in setOf("wav", "aiff", "aif", "pcm")
            val nullTailDetected = !isUncompressedAudio && tailBytes.size >= 32 && tailBytes.all { it == 0.toByte() }
            fun hAt(i: Int): Int = if (i < headBytes.size) (headBytes[i].toInt() and 0xFF) else -1
            fun ascii(start: Int, len: Int): String = if (start + len <= headBytes.size) String(headBytes, start, len, Charsets.US_ASCII) else ""

            val detectedSig = when {
                headBytes.size >= 12 && ascii(4, 4) == "ftyp" -> "ISO-BMFF (${ascii(8, 4).trim()})"
                hAt(0) == 0x1A && hAt(1) == 0x45 && hAt(2) == 0xDF && hAt(3) == 0xA3 -> "EBML (MKV/WebM)"
                ascii(0, 4) == "RIFF" && ascii(8, 4) == "WEBP" -> "RIFF/WebP"
                ascii(0, 4) == "RIFF" && ascii(8, 4) == "WAVE" -> "RIFF/WAV"
                ascii(0, 4) == "RIFF" && ascii(8, 4) == "AVI " -> "RIFF/AVI"
                ascii(0, 4) == "FORM" && ascii(8, 4) == "AIFF" -> "AIFF"
                ascii(0, 4) == "fLaC" -> "FLAC"
                ascii(0, 4) == "OggS" -> "Ogg/Opus"
                ascii(0, 5) == "#!AMR" -> "AMR"
                hAt(0) == 0x0B && hAt(1) == 0x77 -> "AC-3"
                ascii(0, 3) == "FLV" -> "FLV"
                hAt(0) == 0x47 -> "MPEG-TS"
                hAt(0) == 0xFF && (hAt(1) and 0xF6) == 0xF0 -> "AAC (ADTS)"
                ascii(0, 3) == "ID3" || (hAt(0) == 0xFF && (hAt(1) and 0xE0) == 0xE0) -> "MPEG/MP3"
                hAt(0) == 0xFF && hAt(1) == 0xD8 && hAt(2) == 0xFF -> "JPEG (SOI)"
                hAt(0) == 0x89 && ascii(1, 3) == "PNG" -> "PNG"
                ascii(0, 6) == "GIF89a" || ascii(0, 6) == "GIF87a" -> "GIF"
                ascii(0, 2) == "BM" -> "BMP"
                (hAt(0) == 0x49 && hAt(1) == 0x49 && hAt(2) == 0x2A && hAt(3) == 0x00) || (hAt(0) == 0x4D && hAt(1) == 0x4D && hAt(2) == 0x00 && hAt(3) == 0x2A) -> "TIFF"
                else -> "Unknown (${headBytes.take(4).joinToString(" ") { String.format("%02X", it) }})"
            }
            val sigValid = !detectedSig.startsWith("Unknown")
            val isIsoBmffExt = ext in setOf("mp4", "m4v", "mov", "m4a", "3gp", "heic", "heif", "avif")
            val sigMismatch = when (ext) {
                "mp4", "m4v", "mov", "m4a", "3gp", "heic", "heif", "avif" -> !detectedSig.startsWith("ISO-BMFF")
                "mkv", "webm", "mka" -> !detectedSig.startsWith("EBML")
                "jpg", "jpeg" -> !detectedSig.startsWith("JPEG")
                "png" -> detectedSig != "PNG"
                "webp" -> detectedSig != "RIFF/WebP"
                "flac" -> detectedSig != "FLAC"
                "ogg", "opus" -> detectedSig != "Ogg/Opus"
                "wav" -> detectedSig != "RIFF/WAV"
                "mp3" -> detectedSig != "MPEG/MP3"
                else -> false
            }

            emitUiProgress("onIntegrityProgress", 18, "Inspecting container boxes & atoms...", detectedSig)
            // 2. Walk ISO-BMFF boxes (for MP4/MOV/M4A/HEIC/AVIF) to verify moov/meta atom & truncation
            var moovFound = false
            var moovBeforeMdat = false
            var metaFound = false
            var mdatSeen = false
            var truncatedAtom = false
            if (isIsoBmffExt && detectedSig.startsWith("ISO-BMFF")) {
                try {
                    RandomAccessFile(file, "r").use { raf ->
                        var pos = 0L
                        var guard = 0
                        while (pos + 8 <= sizeBytes && guard < 256) {
                            guard++
                            raf.seek(pos)
                            var boxSize = raf.readInt().toLong() and 0xFFFFFFFFL
                            val typeBytes = ByteArray(4)
                            raf.readFully(typeBytes)
                            val boxType = String(typeBytes, Charsets.US_ASCII)
                            if (boxSize == 1L && pos + 16 <= sizeBytes) {
                                boxSize = raf.readLong()
                            } else if (boxSize == 0L) {
                                boxSize = sizeBytes - pos
                            }
                            if (boxSize < 8L || pos + boxSize > sizeBytes) { truncatedAtom = true; break }
                            if (boxType == "moov") {
                                moovFound = true
                                if (!mdatSeen) moovBeforeMdat = true
                            } else if (boxType == "meta") {
                                metaFound = true
                            } else if (boxType == "mdat") {
                                mdatSeen = true
                            }
                            pos += boxSize
                        }
                    }
                } catch (_: Throwable) {}
            }

            emitUiProgress("onIntegrityProgress", 28, "Probing container & stream headers (FFprobe)...", file.name)
            // 3. FFprobe container & stream inspection
            val probe = FFprobeKit.getMediaInformation(path)
            val info = probe.mediaInformation
            val rawProps = info?.allProperties ?: JSONObject()
            val fmtObj = rawProps.optJSONObject("format") ?: JSONObject()
            val streamsArr = rawProps.optJSONArray("streams") ?: JSONArray()
            val chaptersArr = rawProps.optJSONArray("chapters") ?: JSONArray()
            val headerOk = info != null && streamsArr.length() > 0

            val isPhotoExt = NativePhotoEngine.isImageExtension(ext)
            val isAudioExt = ext in setOf("mp3", "flac", "opus", "m4a", "wav", "ogg", "ac3", "aac", "wma", "mka", "amr", "aiff")
            var vObj: JSONObject? = null
            var aObj: JSONObject? = null
            var vCount = 0
            var aCount = 0
            var subCount = 0
            var coverArtCount = 0
            for (i in 0 until streamsArr.length()) {
                val s = streamsArr.optJSONObject(i) ?: continue
                val ct = s.optString("codec_type", "")
                val att = s.optJSONObject("disposition")?.optInt("attached_pic", 0) ?: 0
                val cn = s.optString("codec_name", "").lowercase(Locale.US)
                if (ct.equals("video", true)) {
                    if (att == 1 || (isAudioExt && cn in setOf("mjpeg", "png", "webp", "bmp"))) {
                        coverArtCount++
                    } else {
                        vCount++
                        if (vObj == null) vObj = s
                    }
                } else if (ct.equals("audio", true)) {
                    aCount++
                    if (aObj == null) aObj = s
                } else if (ct.equals("subtitle", true)) {
                    subCount++
                }
            }
            val mediaKind = when {
                isPhotoExt -> "photo"
                vCount > 0 && !isAudioExt -> "video"
                aCount > 0 || isAudioExt -> "audio"
                else -> "video"
            }

            val isMp4VideoOrAudio = (mediaKind != "photo") && ext in setOf("mp4", "m4v", "mov", "m4a", "3gp")
            val durationSec = fmtObj.optString("duration", "0").toDoubleOrNull() ?: 0.0
            val overallBitrate = fmtObj.optString("bit_rate", "0").toLongOrNull() ?: 0L
            val probeScore = fmtObj.optInt("probe_score", 0)
            val vDur = vObj?.optString("duration", "0")?.toDoubleOrNull() ?: durationSec
            val aDur = aObj?.optString("duration", "0")?.toDoubleOrNull() ?: durationSec
            val avDriftMs = if (mediaKind == "video" && vCount > 0 && aCount > 0 && vDur > 0 && aDur > 0) Math.round(Math.abs(vDur - aDur) * 1000.0) else 0L

            val fmtTags = fmtObj.optJSONObject("tags")
            val aTags = aObj?.optJSONObject("tags")
            val audioTagCount = (fmtTags?.length() ?: 0) + (aTags?.length() ?: 0)

            var sizeConsistencyPct = 0
            var sizeMismatchWarning = false
            if (mediaKind != "photo" && durationSec > 0.5 && overallBitrate > 0L) {
                val expectedBytes = (durationSec * overallBitrate) / 8.0
                if (expectedBytes > 0) {
                    sizeConsistencyPct = Math.round((sizeBytes / expectedBytes) * 100.0).toInt().coerceIn(1, 999)
                    if (sizeConsistencyPct < 75 || sizeConsistencyPct > 135) sizeMismatchWarning = true
                }
            }

            // Helper to categorize FFmpeg error lines
            fun analyzeFfmpegLogs(logs: String, rcSuccess: Boolean): List<Any> {
                val lines = logs.trim().lines().filter { it.isNotBlank() }
                val total = if (!rcSuccess || lines.isNotEmpty()) maxOf(lines.size, if (rcSuccess) 0 else 1) else 0
                var pts = 0; var eof = 0; var corrupt = 0
                lines.forEach { ln ->
                    val low = ln.lowercase(Locale.US)
                    if (low.contains("dts") || low.contains("pts") || low.contains("monoton") || low.contains("timestamp") || low.contains("discontinu")) pts++
                    if (low.contains("eof") || low.contains("truncat") || low.contains("premature") || low.contains("moov atom not found") || low.contains("unexpected end") || low.contains("invalid data")) eof++
                    if (low.contains("corrupt") || low.contains("error while decoding") || low.contains("concealing") || low.contains("missing reference") || low.contains("nal") || low.contains("damaged") || low.contains("invalid") || low.contains("overread") || low.contains("crc")) corrupt++
                }
                return listOf(total, corrupt, pts, eof, lines)
            }

            // 4. Media-Type-Specific Corruption Scans!
            var videoDecodeErrors = 0
            var audioDecodeErrors = 0
            var photoDecodeErrors = 0
            var coverArtValid = true
            var corruptFrameErrors = 0
            var timestampErrors = 0
            var eofErrors = 0
            val logBlocks = mutableListOf<String>()

            var bitmapDecoded = true
            var bitmapConfig = "—"
            var imageEofValid = true
            var imageEofNote = ""
            var exifValid = true
            var exifTagCount = 0
            var resolution = if (vObj != null) "${vObj.optInt("width", 0)}×${vObj.optInt("height", 0)}" else ""

            if (mediaKind == "photo") {
                // PHOTO-ONLY CHECKS: EOF markers + WebP RIFF size + HEIC/AVIF boxes + BitmapFactory + ExifInterface + FFmpeg image bitstream
                if (ext == "jpg" || ext == "jpeg") {
                    var foundEoi = false
                    for (i in 0 until tailBytes.size - 1) {
                        if ((tailBytes[i].toInt() and 0xFF) == 0xFF && (tailBytes[i + 1].toInt() and 0xFF) == 0xD9) {
                            foundEoi = true; break
                        }
                    }
                    imageEofValid = foundEoi
                    imageEofNote = if (foundEoi) "JPEG EOI (FF D9) intact" else "Missing JPEG EOI (FF D9) — truncated image"
                } else if (ext == "png") {
                    val tailStr = String(tailBytes, Charsets.ISO_8859_1)
                    imageEofValid = tailStr.contains("IEND")
                    imageEofNote = if (imageEofValid) "PNG IEND chunk intact" else "Missing PNG IEND chunk — truncated image"
                } else if (ext == "webp" && headBytes.size >= 12 && ascii(0, 4) == "RIFF") {
                    val riffSize = ((headBytes[4].toLong() and 0xFF) or ((headBytes[5].toLong() and 0xFF) shl 8) or ((headBytes[6].toLong() and 0xFF) shl 16) or ((headBytes[7].toLong() and 0xFF) shl 24)) + 8L
                    imageEofValid = sizeBytes >= riffSize
                    imageEofNote = if (imageEofValid) "WebP RIFF chunk size matches (${riffSize} B)" else "WebP truncated (${sizeBytes} B < expected ${riffSize} B)"
                } else if (ext in setOf("heic", "heif", "avif")) {
                    imageEofValid = !truncatedAtom && metaFound
                    imageEofNote = if (imageEofValid) "ISO-BMFF meta & mdat boxes intact" else (if (truncatedAtom) "Truncated HEIC/AVIF box" else "Missing HEIC/AVIF meta box")
                } else if (ext == "gif") {
                    val hasTrailer = tailBytes.isNotEmpty() && (tailBytes.last().toInt() and 0xFF) == 0x3B
                    imageEofValid = hasTrailer
                    imageEofNote = if (hasTrailer) "GIF trailer (0x3B) intact" else "Missing GIF trailer (0x3B) — truncated"
                }

                try {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.absolutePath, bounds)
                    val fullW = bounds.outWidth
                    val fullH = bounds.outHeight
                    if (fullW > 0 && fullH > 0) resolution = "${fullW}×${fullH}"
                    val decodeOpts = BitmapFactory.Options().apply {
                        // Avoid OOM on 50MP/108MP phone camera photos while still decoding every pixel block
                        inSampleSize = if (fullW.toLong() * fullH.toLong() > 16_000_000L) 4 else 1
                    }
                    val bmp = BitmapFactory.decodeFile(file.absolutePath, decodeOpts)
                    if (bmp != null && bmp.width > 0 && bmp.height > 0) {
                        bitmapDecoded = true
                        if (resolution.isBlank()) resolution = "${bmp.width}×${bmp.height}"
                        bitmapConfig = bmp.config?.name ?: "ARGB_8888"
                        bmp.recycle()
                    } else {
                        bitmapDecoded = false
                    }
                } catch (_: OutOfMemoryError) {
                    try {
                        val fallbackOpts = BitmapFactory.Options().apply { inSampleSize = 8 }
                        val bmp2 = BitmapFactory.decodeFile(file.absolutePath, fallbackOpts)
                        bitmapDecoded = (bmp2 != null && bmp2.width > 0 && bmp2.height > 0)
                        bmp2?.recycle()
                    } catch (_: Throwable) { bitmapDecoded = false }
                } catch (_: Throwable) {
                    bitmapDecoded = false
                }

                try {
                    val ex = ExifInterface(file.absolutePath)
                    val checkTags = listOf(
                        ExifInterface.TAG_MAKE, ExifInterface.TAG_MODEL, ExifInterface.TAG_DATETIME_ORIGINAL,
                        ExifInterface.TAG_ORIENTATION, ExifInterface.TAG_F_NUMBER, ExifInterface.TAG_EXPOSURE_TIME,
                        ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, ExifInterface.TAG_FOCAL_LENGTH,
                        ExifInterface.TAG_SOFTWARE, ExifInterface.TAG_GPS_LATITUDE
                    )
                    exifTagCount = checkTags.count { !ex.getAttribute(it).isNullOrBlank() }
                    exifValid = true
                } catch (_: Throwable) {
                    exifValid = false
                }

                if (deepScan) {
                    val sImg = FFmpegKit.execute("-v error -err_detect +crccheck+bitstream+buffer+explode -i \"$safePath\" -f null -")
                    val st = analyzeFfmpegLogs(sImg.allLogsAsString ?: "", ReturnCode.isSuccess(sImg.returnCode))
                    photoDecodeErrors = st[0] as Int
                    corruptFrameErrors = st[1] as Int
                    eofErrors = st[3] as Int
                    @Suppress("UNCHECKED_CAST")
                    val lines = st[4] as List<String>
                    if (lines.isNotEmpty()) logBlocks.add("[PHOTO BITSTREAM]\n" + lines.take(25).joinToString("\n"))
                }
            } else if (mediaKind == "video") {
                // VIDEO MODE: Independently scan Video stream (v:0) AND Audio stream (a:0) to pinpoint exact corruption!
                if (!headerOk) {
                    val sHdr = FFmpegKit.execute("-v error -i \"$safePath\" -f null -")
                    val stH = analyzeFfmpegLogs(sHdr.allLogsAsString ?: "", ReturnCode.isSuccess(sHdr.returnCode))
                    videoDecodeErrors = maxOf(1, stH[0] as Int)
                    eofErrors += stH[3] as Int
                    @Suppress("UNCHECKED_CAST")
                    val linesH = stH[4] as List<String>
                    if (linesH.isNotEmpty()) logBlocks.add("[CONTAINER / HEADER ERROR]\n" + linesH.take(20).joinToString("\n"))
                } else if (deepScan) {
                    if (vCount > 0) {
                        val expDurMs = (durationSec * 1000.0).toLong().coerceAtLeast(1000L)
                        emitUiProgress("onIntegrityProgress", 36, "Deep scanning Video stream (v:0)...", file.name)
                        val sVid = executeFfmpegWithProgress("-v error -err_detect +crccheck+bitstream+buffer+explode -i \"$safePath\" -map 0:v:0 -an -sn -dn -f null -", expDurMs) { pct, fps, _ ->
                            val scaled = 36 + ((pct * 34) / 100)
                            val fpsTxt = if (fps > 0f) " · ${fps.toInt()} fps" else ""
                            emitUiProgress("onIntegrityProgress", scaled, "Deep scanning Video stream (v:0) · $pct%$fpsTxt", file.name)
                        }
                        val stV = analyzeFfmpegLogs(sVid.allLogsAsString ?: "", ReturnCode.isSuccess(sVid.returnCode))
                        videoDecodeErrors = stV[0] as Int
                        corruptFrameErrors += stV[1] as Int
                        timestampErrors += stV[2] as Int
                        eofErrors += stV[3] as Int
                        @Suppress("UNCHECKED_CAST")
                        val linesV = stV[4] as List<String>
                        if (linesV.isNotEmpty()) logBlocks.add("[VIDEO STREAM v:0]\n" + linesV.take(20).joinToString("\n"))
                    }
                    if (aCount > 0) {
                        val expDurMsA = (durationSec * 1000.0).toLong().coerceAtLeast(1000L)
                        emitUiProgress("onIntegrityProgress", if (mediaKind == "video") 72 else 40, "Deep scanning Audio stream (a:0)...", file.name)
                        val sAud = executeFfmpegWithProgress("-v error -err_detect +crccheck+bitstream+buffer+explode -i \"$safePath\" -map 0:a:0 -vn -sn -dn -f null -", expDurMsA) { pct, _, _ ->
                            val base = if (mediaKind == "video") 72 else 40
                            val span = if (mediaKind == "video") 18 else 48
                            val scaled = base + ((pct * span) / 100)
                            emitUiProgress("onIntegrityProgress", scaled, "Deep scanning Audio stream (a:0) · $pct%", file.name)
                        }
                        val stA = analyzeFfmpegLogs(sAud.allLogsAsString ?: "", ReturnCode.isSuccess(sAud.returnCode))
                        audioDecodeErrors = stA[0] as Int
                        corruptFrameErrors += stA[1] as Int
                        timestampErrors += stA[2] as Int
                        eofErrors += stA[3] as Int
                        @Suppress("UNCHECKED_CAST")
                        val linesA = stA[4] as List<String>
                        if (linesA.isNotEmpty()) logBlocks.add("[AUDIO STREAM a:0]\n" + linesA.take(20).joinToString("\n"))
                    }
                }
            } else {
                // AUDIO-ONLY MODE: Scan Audio stream (a:0) + verify embedded cover art if present!
                if (!headerOk) {
                    val sHdr = FFmpegKit.execute("-v error -i \"$safePath\" -f null -")
                    val stH = analyzeFfmpegLogs(sHdr.allLogsAsString ?: "", ReturnCode.isSuccess(sHdr.returnCode))
                    audioDecodeErrors = maxOf(1, stH[0] as Int)
                    eofErrors += stH[3] as Int
                    @Suppress("UNCHECKED_CAST")
                    val linesH = stH[4] as List<String>
                    if (linesH.isNotEmpty()) logBlocks.add("[AUDIO CONTAINER / HEADER ERROR]\n" + linesH.take(20).joinToString("\n"))
                } else if (deepScan) {
                    if (aCount > 0) {
                        val expDurMsA = (durationSec * 1000.0).toLong().coerceAtLeast(1000L)
                        emitUiProgress("onIntegrityProgress", if (mediaKind == "video") 72 else 40, "Deep scanning Audio stream (a:0)...", file.name)
                        val sAud = executeFfmpegWithProgress("-v error -err_detect +crccheck+bitstream+buffer+explode -i \"$safePath\" -map 0:a:0 -vn -sn -dn -f null -", expDurMsA) { pct, _, _ ->
                            val base = if (mediaKind == "video") 72 else 40
                            val span = if (mediaKind == "video") 18 else 48
                            val scaled = base + ((pct * span) / 100)
                            emitUiProgress("onIntegrityProgress", scaled, "Deep scanning Audio stream (a:0) · $pct%", file.name)
                        }
                        val stA = analyzeFfmpegLogs(sAud.allLogsAsString ?: "", ReturnCode.isSuccess(sAud.returnCode))
                        audioDecodeErrors = stA[0] as Int
                        corruptFrameErrors += stA[1] as Int
                        timestampErrors += stA[2] as Int
                        eofErrors += stA[3] as Int
                        @Suppress("UNCHECKED_CAST")
                        val linesA = stA[4] as List<String>
                        if (linesA.isNotEmpty()) logBlocks.add("[AUDIO STREAM a:0]\n" + linesA.take(30).joinToString("\n"))
                    }
                    if (coverArtCount > 0) {
                        val sArt = FFmpegKit.execute("-v error -i \"$safePath\" -map 0:v:0 -frames:v 1 -f null -")
                        val artLogs = (sArt.allLogsAsString ?: "").trim()
                        coverArtValid = ReturnCode.isSuccess(sArt.returnCode) && artLogs.isEmpty()
                        if (!coverArtValid && artLogs.isNotEmpty()) logBlocks.add("[EMBEDDED COVER ART]\n" + artLogs.take(400))
                    }
                }
            }

            val decodeErrors = videoDecodeErrors + audioDecodeErrors + photoDecodeErrors
            val errorSnippet = logBlocks.joinToString("\n\n").take(2600)

            emitUiProgress("onIntegrityProgress", 93, "Computing SHA-256 checksum...", file.name)
            // 5. Streaming SHA-256 Checksum
            val sha256 = try {
                val md = MessageDigest.getInstance("SHA-256")
                val buf = ByteArray(65536)
                file.inputStream().use { ins ->
                    var r = ins.read(buf)
                    while (r > 0) {
                        md.update(buf, 0, r)
                        r = ins.read(buf)
                    }
                }
                md.digest().joinToString("") { String.format("%02x", it) }
            } catch (_: Throwable) { "" }

            // 6. Media-Type-Aware Health Score & Verdict
            var score = 100
            val issues = mutableListOf<String>()
            if (!headerOk && mediaKind != "photo") { score -= 55; issues.add("unreadable container header") }
            if (sigMismatch) { score -= 25; issues.add("extension does not match binary signature ($detectedSig)") }
            if (isMp4VideoOrAudio && detectedSig.startsWith("ISO-BMFF") && !moovFound) { score -= 45; issues.add("missing MP4 moov atom") }
            if (truncatedAtom) { score -= 40; issues.add("truncated ISO-BMFF atom box") }
            if (nullTailDetected) { score -= 25; issues.add("null-byte (0x00) file tail") }

            if (mediaKind == "photo") {
                if (!bitmapDecoded) { score -= 60; issues.add("pixel decode failed") }
                if (!imageEofValid) { score -= 35; issues.add(imageEofNote) }
                if (!exifValid) { score -= 10; issues.add("unreadable EXIF header") }
                if (photoDecodeErrors > 0) { score -= minOf(40, 15 + photoDecodeErrors * 4); issues.add("$photoDecodeErrors image bitstream error(s)") }
            } else if (mediaKind == "video") {
                if (videoDecodeErrors > 0) { score -= minOf(45, 15 + videoDecodeErrors * 3); issues.add("$videoDecodeErrors video stream error(s)") }
                if (audioDecodeErrors > 0) { score -= minOf(35, 12 + audioDecodeErrors * 3); issues.add("$audioDecodeErrors embedded audio error(s)") }
                if (avDriftMs > 500) { score -= 10; issues.add("A/V sync drift of ${avDriftMs}ms") }
                if (sizeMismatchWarning) { score -= 10; issues.add("file size differs from header bitrate ($sizeConsistencyPct%)") }
            } else {
                if (audioDecodeErrors > 0) { score -= minOf(50, 15 + audioDecodeErrors * 3); issues.add("$audioDecodeErrors audio packet error(s)") }
                if (coverArtCount > 0 && !coverArtValid) { score -= 10; issues.add("corrupt embedded cover art") }
                if (sizeMismatchWarning) { score -= 10; issues.add("file size differs from header bitrate ($sizeConsistencyPct%)") }
            }
            if (timestampErrors > 0) { score -= minOf(15, 5 + timestampErrors * 2); issues.add("$timestampErrors PTS/DTS warning(s)") }
            score = score.coerceIn(0, 100)

            val isCorrupt = score < 60 ||
                (!headerOk && mediaKind != "photo") ||
                (mediaKind == "photo" && (!bitmapDecoded || !imageEofValid || photoDecodeErrors > 0)) ||
                (mediaKind == "video" && (videoDecodeErrors > 0 || audioDecodeErrors > 0 || truncatedAtom || (isMp4VideoOrAudio && detectedSig.startsWith("ISO-BMFF") && !moovFound))) ||
                (mediaKind == "audio" && (audioDecodeErrors > 0 || truncatedAtom || (isMp4VideoOrAudio && detectedSig.startsWith("ISO-BMFF") && !moovFound)))

            val verdict = when {
                isCorrupt -> "CORRUPTED"
                score < 95 || issues.isNotEmpty() -> "WARNING"
                else -> "HEALTHY"
            }
            val summary = when (verdict) {
                "HEALTHY" -> when (mediaKind) {
                    "photo" -> if (deepScan) "Image signature, EOF marker, full pixel decode, EXIF block, and bitstream passed with 0 errors." else "Image signature, EOF marker, EXIF block, and full pixel decode passed cleanly."
                    "audio" -> if (deepScan) "Audio signature, container header, and every audio packet decoded cleanly with 0 errors." else "Audio signature, container header, and tags are intact (run Deep Scan to verify every packet)."
                    else -> if (deepScan) "Container atoms, Video stream (v:0), and Audio stream (a:0) all decoded cleanly with 0 errors." else "Container header, magic bytes, and MP4 atoms are intact (run Deep Scan to verify video & audio streams)."
                }
                else -> "Detected: " + issues.joinToString("; ") + "."
            }

            val fpsStr = vObj?.optString("avg_frame_rate", "") ?: ""
            val fpsVal = if (fpsStr.contains("/")) {
                val parts = fpsStr.split("/")
                val num = parts.getOrNull(0)?.toDoubleOrNull() ?: 0.0
                val den = parts.getOrNull(1)?.toDoubleOrNull() ?: 1.0
                if (den > 0.0) num / den else 0.0
            } else fpsStr.toDoubleOrNull() ?: 0.0

            JSONObject().apply {
                put("ok", verdict == "HEALTHY")
                put("verdict", verdict)
                put("healthScore", score)
                put("summary", summary)
                put("deepScan", deepScan)
                put("elapsedMs", System.currentTimeMillis() - t0)
                put("mediaKind", mediaKind)
                put("path", path)
                put("filename", file.name)
                put("extension", ext)
                put("fileSizeBytes", sizeBytes)
                put("detectedSignature", detectedSig)
                put("signatureValid", sigValid)
                put("signatureMismatch", sigMismatch)
                put("isMp4Family", isMp4VideoOrAudio)
                put("moovFound", moovFound)
                put("moovBeforeMdat", moovBeforeMdat)
                put("truncatedAtom", truncatedAtom)
                put("nullTailDetected", nullTailDetected)
                put("headerValid", headerOk)
                put("formatName", fmtObj.optString("format_name", ext))
                put("probeScore", probeScore)
                put("streamCount", streamsArr.length())
                put("videoStreamCount", vCount)
                put("audioStreamCount", aCount)
                put("subtitleStreamCount", subCount)
                put("chapterCount", chaptersArr.length())
                put("coverArtCount", coverArtCount)
                put("coverArtValid", coverArtValid)
                put("audioTagCount", audioTagCount)
                put("videoCodec", vObj?.optString("codec_name", "") ?: "")
                put("audioCodec", aObj?.optString("codec_name", "") ?: "")
                put("sampleRate", aObj?.optString("sample_rate", "") ?: "")
                put("audioChannels", aObj?.optInt("channels", 0) ?: 0)
                put("audioSampleFmt", aObj?.optString("sample_fmt", "") ?: "")
                put("resolution", resolution)
                put("fps", fpsVal)
                put("nbFrames", vObj?.optString("nb_frames", "") ?: "")
                put("durationSec", durationSec)
                put("overallBitrate", overallBitrate)
                put("avDriftMs", avDriftMs)
                put("sizeConsistencyPct", sizeConsistencyPct)
                put("sizeMismatchWarning", sizeMismatchWarning)
                put("bitmapDecoded", bitmapDecoded)
                put("bitmapConfig", bitmapConfig)
                put("imageEofValid", imageEofValid)
                put("imageEofNote", imageEofNote)
                put("exifValid", exifValid)
                put("exifTagCount", exifTagCount)
                put("videoDecodeErrors", videoDecodeErrors)
                put("audioDecodeErrors", audioDecodeErrors)
                put("photoDecodeErrors", photoDecodeErrors)
                put("decodeErrorCount", decodeErrors)
                put("corruptFrameErrors", corruptFrameErrors)
                put("timestampErrors", timestampErrors)
                put("eofErrors", eofErrors)
                put("errorSnippet", errorSnippet)
                put("sha256", sha256)
            }.toString()
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("verdict", "CORRUPTED")
                put("healthScore", 0)
                put("path", uriOrPath)
                put("decodeErrorCount", 1)
                put("errorSnippet", "${t.javaClass.simpleName}: ${t.message}")
                put("summary", "Scan error: ${t.message}")
                put("elapsedMs", System.currentTimeMillis() - t0)
            }.toString()
        }
    }

    @JavascriptInterface
    fun runQuickBenchmark(): String {
        return try {
            val start = System.nanoTime()
            val session = FFmpegKit.execute("-f lavfi -i testsrc2=size=1280x720:rate=60 -t 0.3 -c:v libx264 -preset ultrafast -f null -")
            val elapsedSec = (System.nanoTime() - start) / 1_000_000_000.0
            val ok = ReturnCode.isSuccess(session.returnCode)
            JSONObject().apply {
                put("ok", ok)
                put("elapsedSec", elapsedSec)
                put("approxFps", if (elapsedSec > 0) (18.0 / elapsedSec) else 0.0)
                put("error", if (ok) "" else (session.failStackTrace ?: session.allLogsAsString ?: "Benchmark failed").takeLast(200))
            }.toString()
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("approxFps", 0.0)
                put("error", "${t.javaClass.simpleName}: ${t.message}")
            }.toString()
        }
    }

    private fun resolveMimeType(ext: String): String {
        return when (ext.lowercase(Locale.US)) {
            "mp4", "m4v" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "avi" -> "video/x-msvideo"
            "mp3" -> "audio/mpeg"
            "m4a", "aac" -> "audio/mp4"
            "opus", "ogg" -> "audio/ogg"
            "flac" -> "audio/flac"
            "wav" -> "audio/wav"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "heic", "heif" -> "image/heic"
            "avif" -> "image/avif"
            "gif" -> "image/gif"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase(Locale.US)) ?: "*/*"
        }
    }

    @JavascriptInterface
    fun openFile(path: String) {
        try {
            val file = File(path)
            if (!file.exists()) return
            val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val mime = resolveMimeType(file.extension)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(Intent.createChooser(intent, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Throwable) {}
    }

    @JavascriptInterface
    fun shareFile(path: String) {
        try {
            val file = File(path)
            if (!file.exists()) return
            val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val mime = resolveMimeType(file.extension)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(Intent.createChooser(intent, "Share file").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Throwable) {}
    }

    @JavascriptInterface
    fun openFolder(folderPath: String) {
        try {
            val rawTarget = if (folderPath.isBlank()) VaultStorageManager.getRootDir(context) else File(folderPath)
            val targetDir = if (rawTarget.isFile) (rawTarget.parentFile ?: VaultStorageManager.getRootDir(context)) else rawTarget
            if (!targetDir.exists()) targetDir.mkdirs()

            val primaryRoot = Environment.getExternalStorageDirectory().absolutePath.trimEnd('/')
            val absPath = targetDir.absolutePath.trimEnd('/')
            val docId = when {
                absPath.equals(primaryRoot, ignoreCase = true) -> "primary:"
                absPath.startsWith("$primaryRoot/") -> "primary:" + absPath.removePrefix("$primaryRoot/")
                absPath.startsWith("/storage/") -> {
                    val rest = absPath.removePrefix("/storage/")
                    val slash = rest.indexOf('/')
                    if (slash > 0) rest.substring(0, slash) + ":" + rest.substring(slash + 1) else "$rest:"
                }
                else -> "primary:ConversionVault"
            }
            val docUri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", docId)

            // 1. Directly open the exact directory in Android's built-in DocumentsUI (Files) — supports exact path deep-linking on Android 10–16
            for (pkg in listOf("com.google.android.documentsui", "com.android.documentsui")) {
                try {
                    val dirIntent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                        putExtra(DocumentsContract.EXTRA_INITIAL_URI, docUri)
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(dirIntent)
                    return
                } catch (_: Throwable) {}
            }

            // 2. Generic system directory intent (vnd.android.document/directory + EXTRA_INITIAL_URI)
            try {
                val genericDir = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                    putExtra(DocumentsContract.EXTRA_INITIAL_URI, docUri)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                context.startActivity(genericDir)
                return
            } catch (_: Throwable) {}

            // 3. System Document Tree view pre-positioned at the exact target folder
            try {
                val treeIntent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    putExtra(DocumentsContract.EXTRA_INITIAL_URI, docUri)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(treeIntent)
                return
            } catch (_: Throwable) {}

            // 4. Last resort: launch Google Files or MIUI File Manager
            for (pkg in listOf("com.google.android.apps.nbu.files", "com.mi.android.globalFileexplorer")) {
                try {
                    val launch = context.packageManager.getLaunchIntentForPackage(pkg)
                    if (launch != null) {
                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(launch)
                        return
                    }
                } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
    }

    @JavascriptInterface
    fun exportMetadataBackup(baseName: String, content: String, ext: String): String {
        return try {
            val cleanExt = ext.trim().trimStart('.').lowercase(Locale.US).ifBlank { "json" }
            val dir = VaultStorageManager.getModuleDir(context, "Metadata_Modifier", "Extracted_Metadata")
            val safeBase = File(baseName).nameWithoutExtension.ifBlank { "media" } + "_metadata"
            val target = VaultStorageManager.resolveNonConflictingFile(dir, safeBase, cleanExt)
            target.writeText(content)
            try {
                MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null)
            } catch (_: Throwable) {}
            JSONObject().put("ok", true).put("path", target.absolutePath).put("filename", target.name).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Export failed").toString()
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
    fun exportInspectorReport(baseName: String, ext: String, content: String): String {
        return try {
            val safeExt = ext.lowercase(Locale.US).replace(Regex("[^a-z0-9]"), "").ifBlank { "txt" }
            val safeBase = baseName.replace(Regex("[^a-zA-Z0-9_-]"), "_").ifBlank { "inspect_report" }.take(48)
            val dir = VaultStorageManager.getModuleDir(context, "Reports")
            val target = VaultStorageManager.resolveNonConflictingFile(dir, safeBase, safeExt)
            target.writeText(content)
            try { MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null) } catch (_: Throwable) {}
            JSONObject().put("ok", true).put("path", target.absolutePath).put("name", target.name).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
    }



    @JavascriptInterface
    fun extractVideoFrameBase64(inputPath: String, timeMs: Long): String {
        return try {
            val resolved = VaultStorageManager.resolveInputPath(context, inputPath)
            val file = File(resolved)
            if (!file.exists()) {
                return JSONObject().put("ok", false).put("error", "Video file not found").toString()
            }
            var durationMs = 0L
            var bmp: android.graphics.Bitmap? = null
            val mmr = MediaMetadataRetriever()
            try {
                mmr.setDataSource(file.absolutePath)
                durationMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val safeMs = if (durationMs > 0L) timeMs.coerceIn(0L, (durationMs - 40L).coerceAtLeast(0L)) else timeMs.coerceAtLeast(0L)
                bmp = mmr.getFrameAtTime(safeMs * 1000L, MediaMetadataRetriever.OPTION_CLOSEST)
                    ?: mmr.getFrameAtTime(safeMs * 1000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            } catch (_: Throwable) {
            } finally {
                try { mmr.release() } catch (_: Throwable) {}
            }

            if (bmp == null) {
                // Fallback to 1-frame FFmpeg snapshot for MKV / AV1 / exotic codecs
                val tmp = File(context.cacheDir, "cv_frame_${System.currentTimeMillis()}.jpg")
                try {
                    val sec = String.format(Locale.US, "%.3f", timeMs.coerceAtLeast(0L) / 1000.0)
                    val cmd = "-y -ss $sec -i \"${file.absolutePath}\" -frames:v 1 -vf \"scale='min(960,iw)':-2\" -q:v 4 \"${tmp.absolutePath}\""
                    val session = FFmpegKit.execute(cmd)
                    if (ReturnCode.isSuccess(session.returnCode) && tmp.exists() && tmp.length() > 0L) {
                        bmp = BitmapFactory.decodeFile(tmp.absolutePath)
                    }
                } catch (_: Throwable) {
                } finally {
                    try { tmp.delete() } catch (_: Throwable) {}
                }
            }

            if (bmp == null) {
                return JSONObject().put("ok", false).put("durationMs", durationMs).put("error", "Could not decode frame").toString()
            }

            val origW = bmp.width
            val origH = bmp.height
            val finalBmp = if (origW > 960) {
                val targetH = ((origH.toFloat() / origW.toFloat()) * 960f).toInt().coerceAtLeast(1)
                android.graphics.Bitmap.createScaledBitmap(bmp, 960, targetH, true).also {
                    if (it !== bmp) try { bmp.recycle() } catch (_: Throwable) {}
                }
            } else bmp

            val baos = java.io.ByteArrayOutputStream()
            finalBmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, baos)
            val b64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP)
            try { finalBmp.recycle() } catch (_: Throwable) {}

            JSONObject()
                .put("ok", true)
                .put("durationMs", durationMs)
                .put("width", origW)
                .put("height", origH)
                .put("dataUrl", "data:image/jpeg;base64,$b64")
                .toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
    }


    @JavascriptInterface
    fun exportVaultBackupJson(baseName: String, content: String): String {
        return try {
            val safeBase = baseName.replace(Regex("[^a-zA-Z0-9_-]"), "_").ifBlank { "conversion_vault_backup" }.take(48)
            val dir = VaultStorageManager.getModuleDir(context, "Backups")
            val target = VaultStorageManager.resolveNonConflictingFile(dir, safeBase, "json")
            target.writeText(content)
            try { MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null) } catch (_: Throwable) {}
            JSONObject().put("ok", true).put("path", target.absolutePath).put("name", target.name).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
    }

    @JavascriptInterface
    fun exportWorkflowJson(baseName: String, content: String): String {
        return try {
            val safeBase = baseName.replace(Regex("[^a-zA-Z0-9_-]"), "_").ifBlank { "conversion_vault_workflow" }.take(48)
            val dir = VaultStorageManager.getModuleDir(context, "Workflows")
            val target = VaultStorageManager.resolveNonConflictingFile(dir, safeBase, "json")
            target.writeText(content)
            try { MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null) } catch (_: Throwable) {}
            JSONObject().put("ok", true).put("path", target.absolutePath).put("name", target.name).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", "${t.javaClass.simpleName}: ${t.message}").toString()
        }
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
