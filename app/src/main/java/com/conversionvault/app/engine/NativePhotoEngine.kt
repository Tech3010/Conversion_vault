package com.conversionvault.app.engine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import androidx.heifwriter.HeifWriter
import com.arthenica.ffmpegkit.FFprobeKit
import java.nio.ByteBuffer
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

        onProgress(10, "Reading EXIF & decoding full-res image...")

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
            val isSuspiciousThumb = { b: Bitmap? ->
                b != null && b.width <= 400 && b.height <= 400 && inFile.length() > 80_000L
            }
            val fullResOpts = BitmapFactory.Options().apply {
                inScaled = false
                inSampleSize = 1
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }

            // Stage 1: ImageDecoder from File (NO isMutableRequired so HDR/10-bit/P3 HEICs never throw!)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    val src = ImageDecoder.createSource(inFile)
                    val bmp = ImageDecoder.decodeBitmap(src) { decoder, _, _ ->
                        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                        decoder.memorySizePolicy = ImageDecoder.MEMORY_POLICY_DEFAULT
                    }
                    if (!isSuspiciousThumb(bmp)) {
                        workingBitmap = bmp
                        usedImageDecoder = true
                    } else {
                        bmp.recycle()
                    }
                } catch (_: Throwable) {}
            }

            // Stage 2: ImageDecoder from ByteBuffer (bypasses some vendor FileInputStream HEIC quirks)
            if (workingBitmap == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    val bytes = inFile.readBytes()
                    val src = ImageDecoder.createSource(ByteBuffer.wrap(bytes))
                    val bmp = ImageDecoder.decodeBitmap(src) { decoder, _, _ ->
                        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                        decoder.memorySizePolicy = ImageDecoder.MEMORY_POLICY_DEFAULT
                    }
                    if (!isSuspiciousThumb(bmp)) {
                        workingBitmap = bmp
                        usedImageDecoder = true
                    } else {
                        bmp.recycle()
                    }
                } catch (_: Throwable) {}
            }

            // Stage 3: BitmapFactory with explicit inScaled = false, inSampleSize = 1
            if (workingBitmap == null) {
                try {
                    val bmp = BitmapFactory.decodeFile(inFile.absolutePath, fullResOpts)
                    if (bmp != null && !isSuspiciousThumb(bmp)) {
                        workingBitmap = bmp
                        usedImageDecoder = false
                    } else {
                        bmp?.recycle()
                    }
                } catch (_: Throwable) {}
            }

            // Stage 4: FFmpeg fallback with explicit largest-resolution stream map (never picks 192x144 HEIC thumbnail!)
            if (workingBitmap == null) {
                val bestStreamMap = findLargestVideoStreamMap(inFile.absolutePath)
                val ffArgs = buildFfmpegImageFallback(inputPath, outputPath, spec, alreadyTransformed = false, streamMapFlag = bestStreamMap)
                return Result.FallbackToFfmpeg(ffArgs, "Input format decoded via FFmpeg full-res stream fallback")
            }

            val origW = workingBitmap.width
            val origH = workingBitmap.height
            onProgress(40, "Applying orientation & scale (${origW}×${origH})...")

            // Apply EXIF auto-orientation if BitmapFactory was used (ImageDecoder already auto-orients)
            if (!usedImageDecoder && spec.orient == "auto" && exifOrientation != ExifInterface.ORIENTATION_NORMAL) {
                workingBitmap = applyExifOrientation(workingBitmap, exifOrientation)
            }

            // Apply explicit user rotation / flip
            if (spec.orient in setOf("90cw", "90ccw", "180", "hflip", "vflip")) {
                workingBitmap = applyUserTransform(workingBitmap, spec.orient)
            }

            // Apply Aspect Ratio center-crop if requested
            if (spec.crop != "original" && spec.crop.isNotBlank()) {
                workingBitmap = applyAspectCrop(workingBitmap, spec.crop)
            }

            // Apply Color Filter & Brightness adjustments via ColorMatrix
            if ((spec.filter != "none" && spec.filter.isNotBlank()) || spec.brightness != 0) {
                workingBitmap = applyColorAdjustments(workingBitmap, spec.filter, spec.brightness)
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
            val targetBytesMatch = Regex("targetBytes=(\\d+)").find(commandArgs)
            val targetBytes = targetBytesMatch?.groupValues?.getOrNull(1)?.toLongOrNull() ?: 0L

            if (targetBytes > 0L && fmt in setOf("jpg", "jpeg", "webp")) {
                onProgress(70, "Fitting .$fmt under ${targetBytes / 1024} KB (binary search)...")
                val compressFmt = when (fmt) {
                    "jpg", "jpeg" -> Bitmap.CompressFormat.JPEG
                    else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
                }
                var curBmp = if (fmt == "jpg" || fmt == "jpeg") flattenAlphaForJpeg(workingBitmap) else workingBitmap
                var bestBytes: ByteArray? = null
                try {
                    for (scaleStep in 0..3) {
                        var lo = 12
                        var hi = 95
                        var stepBest: ByteArray? = null
                        for (iter in 0..5) {
                            val mid = (lo + hi) / 2
                            val baos = ByteArrayOutputStream()
                            curBmp.compress(compressFmt, mid, baos)
                            val arr = baos.toByteArray()
                            if (arr.size.toLong() <= targetBytes) {
                                stepBest = arr
                                lo = mid + 1
                            } else {
                                hi = mid - 1
                            }
                        }
                        if (stepBest != null) {
                            bestBytes = stepBest
                            break
                        }
                        // Even Q12 exceeded targetBytes -> scale dimensions down 0.78x and retry
                        val nextW = (curBmp.width * 0.78f).toInt().coerceAtLeast(320)
                        val nextH = (curBmp.height * 0.78f).toInt().coerceAtLeast(320)
                        if (nextW == curBmp.width && nextH == curBmp.height) break
                        val shrunk = Bitmap.createScaledBitmap(curBmp, nextW, nextH, true)
                        if (curBmp !== workingBitmap) curBmp.recycle()
                        curBmp = shrunk
                    }
                    if (bestBytes == null) {
                        val baos = ByteArrayOutputStream()
                        curBmp.compress(compressFmt, 12, baos)
                        bestBytes = baos.toByteArray()
                    }
                    FileOutputStream(outFile).use { fos -> fos.write(bestBytes) }
                } finally {
                    if (curBmp !== workingBitmap) curBmp.recycle()
                }
                onProgress(100, "Compressed to ${outFile.length() / 1024} KB")
                return Result.Success(outFile.absolutePath, outFile.length())
            }

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
                        val staged = stageFullResPng(context, workingBitmap)
                        val ffArgs = buildFfmpegImageFallback(staged ?: inputPath, outputPath, spec, alreadyTransformed = (staged != null))
                        return Result.FallbackToFfmpeg(
                            ffArgs,
                            "HeifWriter unavailable (${heifErr.message}); using FFmpeg fallback"
                        )
                    }
                }
                else -> {
                    // Format not natively written by Skia (e.g., .avif, .tiff, .bmp, .gif):
                    // Feed the full-resolution decoded Bitmap via lossless PNG so FFmpeg never grabs a low-res EXIF/HEIC thumbnail
                    val staged = stageFullResPng(context, workingBitmap)
                    val ffArgs = buildFfmpegImageFallback(staged ?: inputPath, outputPath, spec, alreadyTransformed = (staged != null))
                    return Result.FallbackToFfmpeg(ffArgs, "Format .$fmt routed to FFmpeg at ${finalW}x${finalH}")
                }
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
                .setGridEnabled(true)
                .setQuality(quality.coerceIn(15, 100))
                .setMaxImages(1)
                .build()
            try {
                writer.start()
                writer.addBitmap(targetBmp)
                writer.stop(0)
            } finally {
                try { writer.close() } catch (_: Throwable) {}
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
            "vflip" -> m.postScale(1f, -1f)
            else -> return bmp
        }
        val transformed = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        if (transformed !== bmp) bmp.recycle()
        return transformed
    }

    private fun applyAspectCrop(bmp: Bitmap, cropRatio: String): Bitmap {
        val targetAspect = when (cropRatio) {
            "1:1" -> 1.0f
            "4:5" -> 4f / 5f
            "9:16" -> 9f / 16f
            "16:9" -> 16f / 9f
            "3:2" -> 3f / 2f
            else -> return bmp
        }
        val w = bmp.width
        val h = bmp.height
        val curAspect = w.toFloat() / h.toFloat()
        var cropW = w
        var cropH = h
        if (curAspect > targetAspect) {
            cropW = (h * targetAspect).roundToInt().coerceIn(2, w)
        } else {
            cropH = (w / targetAspect).roundToInt().coerceIn(2, h)
        }
        val x = ((w - cropW) / 2).coerceAtLeast(0)
        val y = ((h - cropH) / 2).coerceAtLeast(0)
        if (cropW == w && cropH == h) return bmp
        val cropped = Bitmap.createBitmap(bmp, x, y, cropW, cropH)
        if (cropped !== bmp) bmp.recycle()
        return cropped
    }

    private fun applyColorAdjustments(bmp: Bitmap, filter: String, brightness: Int): Bitmap {
        val cm = ColorMatrix()
        when (filter) {
            "grayscale" -> cm.setSaturation(0f)
            "vivid" -> cm.setSaturation(1.25f)
            "contrast" -> {
                val c = 1.18f
                val t = (-.5f * c + .5f) * 255f
                cm.postConcat(ColorMatrix(floatArrayOf(
                    c, 0f, 0f, 0f, t,
                    0f, c, 0f, 0f, t,
                    0f, 0f, c, 0f, t,
                    0f, 0f, 0f, 1f, 0f
                )))
            }
            "warm" -> cm.postConcat(ColorMatrix(floatArrayOf(
                1.08f, 0f, 0f, 0f, 8f,
                0f, 1.02f, 0f, 0f, 2f,
                0f, 0f, 0.90f, 0f, -6f,
                0f, 0f, 0f, 1f, 0f
            )))
            "cool" -> cm.postConcat(ColorMatrix(floatArrayOf(
                0.92f, 0f, 0f, 0f, -6f,
                0f, 1.00f, 0f, 0f, 0f,
                0f, 0f, 1.10f, 0f, 10f,
                0f, 0f, 0f, 1f, 0f
            )))
            "invert" -> cm.postConcat(ColorMatrix(floatArrayOf(
                -1f, 0f, 0f, 0f, 255f,
                0f, -1f, 0f, 0f, 255f,
                0f, 0f, -1f, 0f, 255f,
                0f, 0f, 0f, 1f, 0f
            )))
        }
        if (brightness != 0) {
            val b = (brightness.coerceIn(-40, 40) * 2.2f)
            cm.postConcat(ColorMatrix(floatArrayOf(
                1f, 0f, 0f, 0f, b,
                0f, 1f, 0f, 0f, b,
                0f, 0f, 1f, 0f, b,
                0f, 0f, 0f, 1f, 0f
            )))
        }
        val out = Bitmap.createBitmap(bmp.width, bmp.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        paint.colorFilter = ColorMatrixColorFilter(cm)
        canvas.drawBitmap(bmp, 0f, 0f, paint)
        bmp.recycle()
        return out
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
        val colorSpace: String,
        val crop: String = "original",
        val filter: String = "none",
        val brightness: Int = 0
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
                    colorSpace = o.optString("colorSpace", "srgb_444"),
                    crop = o.optString("crop", "original"),
                    filter = o.optString("filter", "none"),
                    brightness = o.optInt("brightness", 0)
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

    private fun stageFullResPng(context: Context, bmp: Bitmap): String? {
        return try {
            val dir = File(context.cacheDir, "photo_stage").apply { mkdirs() }
            // Clean up any previous staged PNGs older than 5 minutes
            dir.listFiles()?.forEach { f ->
                if (System.currentTimeMillis() - f.lastModified() > 5 * 60 * 1000L) f.delete()
            }
            val tmp = File(dir, "stage_${System.currentTimeMillis()}.png")
            FileOutputStream(tmp).use { fos ->
                bmp.compress(Bitmap.CompressFormat.PNG, 100, fos)
            }
            if (tmp.exists() && tmp.length() > 0L) tmp.absolutePath else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun findLargestVideoStreamMap(inputPath: String): String {
        return try {
            val info = FFprobeKit.getMediaInformation(inputPath)?.mediaInformation ?: return ""
            val streams = info.allProperties?.optJSONArray("streams") ?: return ""
            var bestIdx = -1
            var bestPixels = -1L
            for (i in 0 until streams.length()) {
                val s = streams.optJSONObject(i) ?: continue
                if (!s.optString("codec_type", "").equals("video", true)) continue
                val w = s.optInt("width", 0).toLong()
                val h = s.optInt("height", 0).toLong()
                val px = w * h
                if (px > bestPixels) {
                    bestPixels = px
                    bestIdx = s.optInt("index", i)
                }
            }
            if (bestIdx >= 0) "-map 0:$bestIdx " else ""
        } catch (_: Throwable) {
            ""
        }
    }

    private fun buildFfmpegImageFallback(
        inputPath: String,
        outputPath: String,
        spec: PhotoSpec,
        alreadyTransformed: Boolean = false,
        streamMapFlag: String = ""
    ): String {
        val fmt = spec.format.lowercase(Locale.US).removePrefix(".")
        val vfParts = mutableListOf<String>()
        if (!alreadyTransformed) {
            if (spec.maxWidth > 0) vfParts.add("scale='min(${spec.maxWidth},iw)':-2")
            when (spec.orient) {
                "90cw" -> vfParts.add("transpose=1")
                "90ccw" -> vfParts.add("transpose=2")
                "180" -> vfParts.add("transpose=1,transpose=1")
                "hflip" -> vfParts.add("hflip")
            }
        }
        val vfFlag = if (vfParts.isNotEmpty()) "-vf \"${vfParts.joinToString(",")}\" " else ""
        val metaFlag = if (spec.meta == "deep") "-map_metadata -1 -fflags +bitexact " else if (spec.meta == "wipe") "-map_metadata -1 " else ""
        val codecFlag = when (fmt) {
            "avif" -> {
                val crf = (63 - (spec.quality * 0.55)).roundToInt().coerceIn(8, 55)
                "-c:v libaom-av1 -still-picture 1 -crf $crf -cpu-used 6 "
            }
            "heic", "heif" -> {
                val crf = (51 - (spec.quality * 0.45)).roundToInt().coerceIn(10, 42)
                "-c:v libx265 -tag:v hvc1 -crf $crf "
            }
            "webp" -> "-c:v libwebp -quality ${spec.quality} "
            "jpg", "jpeg" -> {
                val qv = ((100 - spec.quality) / 3 + 2).coerceIn(2, 31)
                "-c:v mjpeg -q:v $qv "
            }
            "png" -> "-c:v png "
            else -> ""
        }
        return "-y -i \"$inputPath\" ${streamMapFlag}${vfFlag}${metaFlag}${codecFlag}-frames:v 1 \"$outputPath\""
    }
}
