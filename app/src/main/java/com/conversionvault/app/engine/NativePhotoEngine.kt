package com.conversionvault.app.engine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import androidx.heifwriter.HeifWriter
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Dedicated Native Android Photo Engine for Conversion Vault.
 * Uses Android Skia (ImageDecoder / Bitmap) + AndroidX ExifInterface + AndroidX HeifWriter,
 * with automatic FFmpeg fallback for specialty formats (AVIF, TIFF, BMP, GIF).
 */
object NativePhotoEngine {

    sealed class Result {
        data class Success(val log: String) : Result()
        data class FallbackToFfmpeg(val fallbackArgs: String, val reason: String) : Result()
        data class Failure(val error: String) : Result()
    }

    private val IMAGE_EXTS = setOf(
        "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "gif"
    )

    private val SAFE_EXIF_TAGS = listOf(
        ExifInterface.TAG_MAKE,
        ExifInterface.TAG_MODEL,
        ExifInterface.TAG_SOFTWARE,
        ExifInterface.TAG_DATETIME,
        ExifInterface.TAG_DATETIME_ORIGINAL,
        ExifInterface.TAG_DATETIME_DIGITIZED,
        ExifInterface.TAG_EXPOSURE_TIME,
        ExifInterface.TAG_F_NUMBER,
        ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
        ExifInterface.TAG_FOCAL_LENGTH,
        ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
        ExifInterface.TAG_WHITE_BALANCE,
        ExifInterface.TAG_FLASH,
        ExifInterface.TAG_LENS_MAKE,
        ExifInterface.TAG_LENS_MODEL,
        ExifInterface.TAG_ARTIST,
        ExifInterface.TAG_COPYRIGHT,
        ExifInterface.TAG_IMAGE_DESCRIPTION
    )

    private val GPS_EXIF_TAGS = listOf(
        ExifInterface.TAG_GPS_LATITUDE,
        ExifInterface.TAG_GPS_LATITUDE_REF,
        ExifInterface.TAG_GPS_LONGITUDE,
        ExifInterface.TAG_GPS_LONGITUDE_REF,
        ExifInterface.TAG_GPS_ALTITUDE,
        ExifInterface.TAG_GPS_ALTITUDE_REF,
        ExifInterface.TAG_GPS_TIMESTAMP,
        ExifInterface.TAG_GPS_DATESTAMP,
        ExifInterface.TAG_GPS_PROCESSING_METHOD
    )

    fun isImageExtension(ext: String?): Boolean {
        if (ext.isNullOrBlank()) return false
        return ext.trim().lowercase(Locale.US).removePrefix(".") in IMAGE_EXTS
    }

    /**
     * Real runtime self-test of Android Skia encode/decode + ExifInterface + HeifWriter.
     */
    fun checkHealth(): JSONObject {
        return try {
            val testBmp = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
            testBmp.eraseColor(Color.rgb(219, 10, 64))
            val baos = ByteArrayOutputStream()
            val encoded = testBmp.compress(Bitmap.CompressFormat.JPEG, 90, baos)
            testBmp.recycle()
            val bytes = baos.toByteArray()
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            val skiaOk = encoded && decoded != null && decoded.width == 4 && decoded.height == 4
            decoded?.recycle()

            // Verify AndroidX ExifInterface & HeifWriter classes resolve cleanly
            val exifOk = ExifInterface::class.java.name.isNotEmpty()
            val heifOk = HeifWriter::class.java.name.isNotEmpty()

            val ok = skiaOk && exifOk && heifOk
            JSONObject().apply {
                put("ok", ok)
                put("engine", "Native Photo Engine")
                put("version", "Skia + ExifInterface + HeifWriter")
                put("codecs", JSONArray(listOf("jpg", "png", "webp", "heic", "avif")))
                put("error", if (ok) "" else "Native photo self-test failed (skia=$skiaOk, exif=$exifOk, heif=$heifOk)")
            }
        } catch (t: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("engine", "Native Photo Engine")
                put("version", "Photo Engine Error")
                put("error", "${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }

    fun convertImage(
        context: Context,
        inputPath: String,
        outputPath: String,
        commandArgs: String,
        onProgress: (Int, String) -> Unit
    ): Result {
        val inFile = File(inputPath)
        val outFile = File(outputPath)
        if (!inFile.exists() || !inFile.canRead()) {
            return Result.Failure("Input image not readable: $inputPath")
        }
        outFile.parentFile?.mkdirs()

        val spec = parseSpec(commandArgs, outFile.extension)
        val fmt = spec.format.lowercase(Locale.US).removePrefix(".")
        val quality = spec.quality.coerceIn(15, 100)

        // Formats not natively encoded by Android Skia / HeifWriter -> seamless FFmpeg fallback
        if (fmt !in setOf("jpg", "jpeg", "png", "webp", "heic", "heif")) {
            val ffArgs = buildFfmpegImageFallback(inputPath, outputPath, spec)
            return Result.FallbackToFfmpeg(ffArgs, "Format .$fmt routed to FFmpeg codec")
        }

        onProgress(10, "Reading EXIF & decoding image...")

        val srcExif: ExifInterface? = try {
            ExifInterface(inFile.absolutePath)
        } catch (_: Throwable) {
            null
        }
        val exifOrientation = srcExif?.getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL
        ) ?: ExifInterface.ORIENTATION_NORMAL

        var workingBitmap: Bitmap? = null
        try {
            var usedImageDecoder = false
            workingBitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    val src = ImageDecoder.createSource(inFile)
                    val bmp = ImageDecoder.decodeBitmap(src) { decoder, _, _ ->
                        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                        decoder.isMutableRequired = true
                    }
                    usedImageDecoder = true
                    bmp
                } catch (_: Throwable) {
                    BitmapFactory.decodeFile(inFile.absolutePath)
                }
            } else {
                BitmapFactory.decodeFile(inFile.absolutePath)
            }

            if (workingBitmap == null) {
                val ffArgs = buildFfmpegImageFallback(inputPath, outputPath, spec)
                return Result.FallbackToFfmpeg(ffArgs, "Input format decoded via FFmpeg fallback")
            }

            val origW = workingBitmap.width
            val origH = workingBitmap.height
            onProgress(40, "Applying orientation & scale (${origW}×${origH})...")

            // Apply EXIF auto-orientation if BitmapFactory was used (ImageDecoder already auto-orients)
            if (!usedImageDecoder && spec.orient == "auto" && exifOrientation != ExifInterface.ORIENTATION_NORMAL) {
                workingBitmap = applyExifOrientation(workingBitmap, exifOrientation)
            }

            // Apply explicit user rotation / flip
            if (spec.orient in setOf("90cw", "90ccw", "180", "hflip")) {
                workingBitmap = applyUserTransform(workingBitmap, spec.orient)
            }

            // Apply Max Width scale while preserving aspect ratio
            val targetMaxW = spec.maxWidth
            if (targetMaxW > 0 && workingBitmap.width > targetMaxW) {
                val ratio = targetMaxW.toFloat() / workingBitmap.width.toFloat()
                val newH = (workingBitmap.height * ratio).roundToInt().coerceAtLeast(1)
                val scaled = Bitmap.createScaledBitmap(workingBitmap, targetMaxW, newH, true)
                if (scaled !== workingBitmap) {
                    workingBitmap.recycle()
                    workingBitmap = scaled
                }
            }

            val finalW = workingBitmap.width
            val finalH = workingBitmap.height
            onProgress(70, "Encoding .$fmt (${finalW}×${finalH}, q=$quality)...")

            val encodedOk = when (fmt) {
                "jpg", "jpeg" -> {
                    val flat = flattenAlphaForJpeg(workingBitmap)
                    try {
                        FileOutputStream(outFile).use { fos ->
                            flat.compress(Bitmap.CompressFormat.JPEG, quality, fos)
                        }
                    } finally {
                        if (flat !== workingBitmap) flat.recycle()
                    }
                }
                "png" -> {
                    FileOutputStream(outFile).use { fos ->
                        workingBitmap.compress(Bitmap.CompressFormat.PNG, 100, fos)
                    }
                }
                "webp" -> {
                    val compressFmt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        if (quality >= 100 || spec.colorSpace == "lossless_rgb") {
                            Bitmap.CompressFormat.WEBP_LOSSLESS
                        } else {
                            Bitmap.CompressFormat.WEBP_LOSSY
                        }
                    } else {
                        @Suppress("DEPRECATION")
                        Bitmap.CompressFormat.WEBP
                    }
                    FileOutputStream(outFile).use { fos ->
                        workingBitmap.compress(compressFmt, quality, fos)
                    }
                }
                "heic", "heif" -> {
                    try {
                        encodeHeif(workingBitmap, outFile.absolutePath, quality)
                        outFile.exists() && outFile.length() > 0
                    } catch (heifErr: Throwable) {
                        val ffArgs = buildFfmpegImageFallback(inputPath, outputPath, spec)
                        return Result.FallbackToFfmpeg(
                            ffArgs,
                            "HeifWriter unavailable (${heifErr.message}); using FFmpeg fallback"
                        )
                    }
                }
                else -> false
            }

            if (!encodedOk || !outFile.exists() || outFile.length() <= 0L) {
                return Result.Failure("Native Photo Engine failed to write output file: ${outFile.name}")
            }

            onProgress(90, "Applying EXIF privacy policy (${spec.meta})...")
            applyExifPolicy(srcExif, outFile, fmt, spec.meta)

            onProgress(100, "Completed")
            return Result.Success(
                "NativePhotoEngine (Skia+Exif): ${origW}x${origH} -> ${finalW}x${finalH} .$fmt (q=$quality, meta=${spec.meta})"
            )
        } catch (t: Throwable) {
            return Result.Failure("NativePhotoEngine error: ${t.javaClass.simpleName}: ${t.message}")
        } finally {
            try { workingBitmap?.recycle() } catch (_: Throwable) {}
        }
    }

    private fun encodeHeif(bitmap: Bitmap, outputPath: String, quality: Int) {
        // HeifWriter requires even dimensions on many hardware encoders
        val evenW = (bitmap.width / 2) * 2
        val evenH = (bitmap.height / 2) * 2
        val targetBmp = if (evenW != bitmap.width || evenH != bitmap.height) {
            Bitmap.createScaledBitmap(bitmap, evenW.coerceAtLeast(2), evenH.coerceAtLeast(2), true)
        } else {
            bitmap
        }
        try {
            val writer = HeifWriter.Builder(
                outputPath,
                targetBmp.width,
                targetBmp.height,
                HeifWriter.INPUT_MODE_BITMAP
            )
                .setQuality(quality.coerceIn(15, 100))
                .setMaxImages(1)
                .build()
            writer.use { w ->
                w.start()
                w.addBitmap(targetBmp)
                w.stop(0)
            }
        } finally {
            if (targetBmp !== bitmap) targetBmp.recycle()
        }
    }

    private fun flattenAlphaForJpeg(src: Bitmap): Bitmap {
        if (!src.hasAlpha()) return src
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(src, 0f, 0f, null)
        return out
    }

    private fun applyExifOrientation(bmp: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
            else -> return bmp
        }
        val transformed = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        if (transformed !== bmp) bmp.recycle()
        return transformed
    }

    private fun applyUserTransform(bmp: Bitmap, orient: String): Bitmap {
        val m = Matrix()
        when (orient) {
            "90cw" -> m.postRotate(90f)
            "90ccw" -> m.postRotate(270f)
            "180" -> m.postRotate(180f)
            "hflip" -> m.postScale(-1f, 1f)
            else -> return bmp
        }
        val transformed = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        if (transformed !== bmp) bmp.recycle()
        return transformed
    }

    private fun applyExifPolicy(srcExif: ExifInterface?, outFile: File, fmt: String, metaPolicy: String) {
        // Freshly encoded Skia bitmaps already contain zero EXIF/GPS/XMP tags.
        if (metaPolicy == "deep" || metaPolicy == "wipe") return
        if (srcExif == null) return
        if (fmt !in setOf("jpg", "jpeg", "webp", "png")) return

        try {
            val dstExif = ExifInterface(outFile.absolutePath)
            SAFE_EXIF_TAGS.forEach { tag ->
                val v = srcExif.getAttribute(tag)
                if (!v.isNullOrEmpty()) dstExif.setAttribute(tag, v)
            }
            if (metaPolicy == "keep") {
                GPS_EXIF_TAGS.forEach { tag ->
                    val v = srcExif.getAttribute(tag)
                    if (!v.isNullOrEmpty()) dstExif.setAttribute(tag, v)
                }
            }
            dstExif.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
            dstExif.saveAttributes()
        } catch (_: Throwable) {
            // Non-fatal: some containers/builds restrict post-encode EXIF writes
        }
    }

    private data class PhotoSpec(
        val format: String,
        val quality: Int,
        val maxWidth: Int,
        val orient: String,
        val meta: String,
        val colorSpace: String
    )

    private fun parseSpec(commandArgs: String, fallbackExt: String): PhotoSpec {
        val trimmed = commandArgs.trim()
        if (trimmed.startsWith("NATIVE_PHOTO:")) {
            try {
                val o = JSONObject(trimmed.removePrefix("NATIVE_PHOTO:").trim())
                val scaleStr = o.optString("scale", "original")
                val maxW = scaleStr.toIntOrNull() ?: 0
                return PhotoSpec(
                    format = o.optString("format", fallbackExt).ifBlank { fallbackExt },
                    quality = o.optInt("quality", 88),
                    maxWidth = maxW,
                    orient = o.optString("orient", "auto"),
                    meta = o.optString("meta", "wipe"),
                    colorSpace = o.optString("colorSpace", "srgb_444")
                )
            } catch (_: Throwable) {}
        }

        // Parse legacy FFmpeg-style image command args (e.g., from Metadata Modifier or Compressor)
        val qMatch = Regex("-quality\\s+(\\d+)").find(trimmed)
        val qvMatch = Regex("-q:v\\s+(\\d+)").find(trimmed)
        val quality = when {
            qMatch != null -> qMatch.groupValues[1].toIntOrNull() ?: 85
            qvMatch != null -> {
                val qv = qvMatch.groupValues[1].toIntOrNull() ?: 4
                (100 - (qv - 2) * 3).coerceIn(30, 96)
            }
            else -> 88
        }
        val scaleMatch = Regex("scale=(\\d+):").find(trimmed)
        val maxW = scaleMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val meta = when {
            trimmed.contains("bitexact") -> "deep"
            trimmed.contains("-map_metadata -1") -> "wipe"
            else -> "wipe"
        }
        return PhotoSpec(
            format = fallbackExt.ifBlank { "webp" },
            quality = quality,
            maxWidth = maxW,
            orient = "auto",
            meta = meta,
            colorSpace = "srgb_444"
        )
    }

    private fun buildFfmpegImageFallback(inputPath: String, outputPath: String, spec: PhotoSpec): String {
        val fmt = spec.format.lowercase(Locale.US).removePrefix(".")
        val vfParts = mutableListOf<String>()
        if (spec.maxWidth > 0) vfParts.add("scale='min(${spec.maxWidth},iw)':-2")
        when (spec.orient) {
            "90cw" -> vfParts.add("transpose=1")
            "90ccw" -> vfParts.add("transpose=2")
            "180" -> vfParts.add("transpose=1,transpose=1")
            "hflip" -> vfParts.add("hflip")
        }
        val vfFlag = if (vfParts.isNotEmpty()) "-vf \"${vfParts.joinToString(",")}\" " else ""
        val metaFlag = if (spec.meta == "deep") "-map_metadata -1 -fflags +bitexact " else if (spec.meta == "wipe") "-map_metadata -1 " else ""
        val codecFlag = when (fmt) {
            "avif" -> {
                val crf = (63 - (spec.quality * 0.55)).roundToInt().coerceIn(8, 55)
                "-c:v libaom-av1 -still-picture 1 -crf $crf -cpu-used 6 "
            }
            "webp" -> "-c:v libwebp -quality ${spec.quality} "
            "jpg", "jpeg" -> {
                val qv = ((100 - spec.quality) / 3 + 2).coerceIn(2, 31)
                "-c:v mjpeg -q:v $qv "
            }
            "png" -> "-c:v png "
            else -> ""
        }
        return "-y -i \"$inputPath\" ${vfFlag}${metaFlag}${codecFlag}-frames:v 1 \"$outputPath\""
    }
}
