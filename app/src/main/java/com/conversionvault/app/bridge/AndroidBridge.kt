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
import java.util.Locale
import java.util.UUID

class AndroidBridge(
    private val activity: MainActivity
) {
    private val context: Context get() = activity.applicationContext
    private val db: VaultDatabase get() = VaultDatabase.getInstance(context)
    private val prefs get() = context.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun checkEngineHealth(): String {
        return try {
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
            JSONObject().apply {
                put("ok", allOk)
                put("ffmpegOk", ffOk)
                put("ffprobeOk", fpOk)
                put("photoEngineOk", photoOk)
                put("photoEngineVersion", photo.optString("version", "Skia + Exif + Heif"))
                put("version", firstLine.take(60))
                put("error", errParts.joinToString(" | ").take(260))
            }.toString()
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

    @JavascriptInterface
    fun getDeviceTelemetry(): String {
        return HardwareProfiler.collectTelemetry(context).toString()
    }

    @JavascriptInterface
    fun runBenchmark(): String {
        return try {
            val threads = prefs.getString("default_threads", "8")?.toIntOrNull() ?: 8
            val startNs = System.nanoTime()
            val session = FFmpegKit.execute("-loglevel error -threads $threads -f lavfi -i testsrc2=size=1920x1080:rate=60 -t 1 -c:v libx264 -preset fast -pix_fmt yuv420p -f null -")
            val elapsedMs = ((System.nanoTime() - startNs) / 1_000_000L).coerceAtLeast(1L)
            val ok = ReturnCode.isSuccess(session.returnCode)
            val fps = if (ok) (60.0 / (elapsedMs / 1000.0)) else 0.0
            val telemetry = HardwareProfiler.collectTelemetry(context)
            val codecs = telemetry.optJSONObject("codecs") ?: JSONObject()
            val measuredFps = String.format(Locale.US, "%.1f", fps).toDouble()
            val testResult = JSONObject().apply {
                put("ok", ok)
                put("fps", measuredFps)
                put("elapsedMs", elapsedMs)
                put("threads", threads)
                put("testedAt", System.currentTimeMillis())
                put("codecs", codecs)
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
        }
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

        val defSuffix = prefs.getString("default_suffix_rule", "none") ?: "none"
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

                val defSuffix = prefs.getString("default_suffix_rule", "none") ?: "none"
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

    @JavascriptInterface
    fun getPresets(includeDeleted: Boolean): String {
        ensureBuiltInPresetsSeeded()
        return try {
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
            arr.toString()
        } catch (_: Throwable) {
            "[]"
        }
    }

    @JavascriptInterface
    fun savePreset(presetJsonStr: String): String {
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
        return try {
            runBlocking { db.presetDao().softDeletePreset(id) }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Delete failed").toString()
        }
    }

    @JavascriptInterface
    fun restorePreset(id: String): String {
        return try {
            runBlocking { db.presetDao().restorePreset(id) }
            JSONObject().put("ok", true).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "Restore failed").toString()
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
    fun getSettings(): String {
        return JSONObject().apply {
            put("theme", prefs.getString("theme", "dark"))
            put("defaultVaultFolder", prefs.getString("default_vault_folder", VaultStorageManager.getRootDir(context).absolutePath))
            put("originalSourcePolicy", prefs.getString("original_source_policy", "keep"))
            put("defaultSubfolderStyle", prefs.getString("default_subfolder_style", "numbered"))
            put("defaultSuffixRule", prefs.getString("default_suffix_rule", "none"))
            put("separateByType", prefs.getBoolean("separate_by_type", true))
            put("defaultThreads", prefs.getString("default_threads", "8"))
            put("hwPreference", prefs.getString("hw_preference", "sw_hq"))
            put("logLevel", prefs.getString("log_level", "info"))
            put("thermalGuard", prefs.getBoolean("thermal_guard", true))
            put("keepScreenAwake", prefs.getBoolean("keep_screen_awake", true))
            put("benchFps", prefs.getFloat("bench_fps", 0f).toDouble())
            put("hwTestJson", prefs.getString("hw_test_json", "") ?: "")
            val stagedDir = File(context.cacheDir, "staged_inputs")
            val stagedBytes = stagedDir.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
            val rootTmpBytes = context.cacheDir.listFiles()?.filter { it.isFile && (it.name.endsWith(".tmp") || it.name.startsWith("photo_stage_") || it.name.startsWith("heic_stage_")) }?.sumOf { it.length() } ?: 0L
            val cacheBytes = stagedBytes + rootTmpBytes
            put("cacheSizeBytes", cacheBytes)
            put("defaultMetadataPolicy", prefs.getString("default_metadata_policy", "forensic"))
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
            if (o.has("defaultSubfolderStyle")) putString("default_subfolder_style", o.getString("defaultSubfolderStyle"))
            if (o.has("defaultSuffixRule")) putString("default_suffix_rule", o.getString("defaultSuffixRule"))
            if (o.has("separateByType")) putBoolean("separate_by_type", o.optBoolean("separateByType", true))
            if (o.has("defaultThreads")) putString("default_threads", o.getString("defaultThreads"))
            if (o.has("hwPreference")) putString("hw_preference", o.getString("hwPreference"))
            if (o.has("logLevel")) putString("log_level", o.getString("logLevel"))
            if (o.has("defaultMetadataPolicy")) putString("default_metadata_policy", o.getString("defaultMetadataPolicy"))
            if (o.has("sampleRetentionDays")) {
                val d = o.getInt("sampleRetentionDays")
                putInt("sample_retention_days", d)
                if (d > 0) {
                    try { VaultStorageManager.cleanupExpiredSamples(context, d) } catch (_: Throwable) {}
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

    @JavascriptInterface
    fun clearCache(): String {
        var bytesFreed = 0L
        try {
            val staged = File(context.cacheDir, "staged_inputs")
            staged.listFiles()?.forEach { f ->
                if (f.isFile) {
                    bytesFreed += f.length()
                    f.delete()
                }
            }
            context.cacheDir.listFiles()?.forEach { f ->
                if (f.isFile && (f.name.endsWith(".tmp") || f.name.startsWith("photo_stage_") || f.name.startsWith("heic_stage_"))) {
                    bytesFreed += f.length()
                    f.delete()
                }
            }
        } catch (_: Throwable) {}
        return JSONObject().put("ok", true).put("bytesFreed", bytesFreed).toString()
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
            val res = try {
                outFile.parentFile?.mkdirs()
                val session = FFmpegKit.execute(finalCmd)
                val ok = ReturnCode.isSuccess(session.returnCode) && outFile.exists() && outFile.length() > 0L
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
                activity.evalJsFromBridge("window.onSampleGenerated && window.onSampleGenerated($res);")
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
    fun runIntegrityCheck(uriOrPath: String, deepScan: Boolean): String {
        return try {
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
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("path", uriOrPath)
                put("decodeErrorCount", 1)
                put("errorSnippet", "${t.javaClass.simpleName}: ${t.message}")
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

            // 1. Standard Android DocumentsUI / default system Files app (opens the exact directory cleanly)
            val systemDirs = listOf(
                "com.google.android.documentsui",
                "com.android.documentsui",
                "com.google.android.apps.nbu.files"
            )
            for (pkg in systemDirs) {
                try {
                    val dirIntent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    if (dirIntent.resolveActivity(context.packageManager) != null) {
                        context.startActivity(dirIntent)
                        return
                    }
                } catch (_: Throwable) {}
            }

            // 2. Generic system directory viewer (vnd.android.document/directory) — never uses broken resource/folder
            val genericDir = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            if (genericDir.resolveActivity(context.packageManager) != null) {
                context.startActivity(genericDir)
                return
            }

            // 3. Fallback: launch Google Files / MIUI File Manager / system Files directly
            val fallbackPkgs = listOf(
                "com.google.android.apps.nbu.files",
                "com.mi.android.globalFileexplorer",
                "com.google.android.documentsui",
                "com.android.documentsui"
            )
            for (pkg in fallbackPkgs) {
                val launch = context.packageManager.getLaunchIntentForPackage(pkg)
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(launch)
                    return
                }
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
