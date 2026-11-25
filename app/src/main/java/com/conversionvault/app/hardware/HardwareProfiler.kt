package com.conversionvault.app.hardware

import android.app.ActivityManager
import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.os.Environment
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

object HardwareProfiler {

    data class CpuCluster(val maxFreqKHz: Long, val coreIndices: List<Int>)

    fun collectTelemetry(context: Context): JSONObject {
        val model = "${Build.MANUFACTURER.uppercase(Locale.ROOT)} ${Build.MODEL}".trim()
        val soc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Build.SOC_MODEL.ifBlank { Build.HARDWARE }
        } else {
            Build.HARDWARE
        }

        val clusters = detectCpuClusters()
        val totalCores = clusters.sumOf { it.coreIndices.size }.coerceAtLeast(Runtime.getRuntime().availableProcessors())
        val cpuSummary = if (clusters.isNotEmpty()) {
            clusters.joinToString(" + ") { c ->
                val ghz = String.format(Locale.US, "%.2f", c.maxFreqKHz / 1_000_000.0)
                "${c.coreIndices.size}×${ghz}GHz"
            }
        } else {
            "${totalCores} Cores"
        }

        // Compute taskset bitmask for big/performance cores (all non-efficiency cores if heterogeneous)
        val perfMaskInt = if (clusters.size > 1) {
            val minFreq = clusters.minOf { it.maxFreqKHz }
            clusters.filter { it.maxFreqKHz > minFreq }
                .flatMap { it.coreIndices }
                .fold(0) { acc, idx -> acc or (1 shl idx) }
        } else {
            (1 shl totalCores) - 1
        }
        val tasksetHex = "0x" + Integer.toHexString(perfMaskInt.coerceAtLeast(1))

        // RAM
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        val totalRamGb = String.format(Locale.US, "%.1f GB", memInfo.totalMem / (1024.0 * 1024.0 * 1024.0))
        val availRamGb = String.format(Locale.US, "%.1f GB", memInfo.availMem / (1024.0 * 1024.0 * 1024.0))

        // Internal Storage
        val internalStat = StatFs(Environment.getExternalStorageDirectory().absolutePath)
        val intFreeGb = String.format(Locale.US, "%.1f GB Free", internalStat.availableBytes / (1024.0 * 1024.0 * 1024.0))

        // External SD / USB-OTG detection
        val extDirs = context.getExternalFilesDirs(null)
        val removableVolumes = JSONArray()
        var extSummary = "None"
        extDirs.drop(1).forEachIndexed { idx, dir ->
            if (dir != null && Environment.isExternalStorageRemovable(dir)) {
                try {
                    val stat = StatFs(dir.absolutePath)
                    val freeGb = String.format(Locale.US, "%.1f GB", stat.availableBytes / (1024.0 * 1024.0 * 1024.0))
                    val totalGb = String.format(Locale.US, "%.1f GB", stat.totalBytes / (1024.0 * 1024.0 * 1024.0))
                    removableVolumes.put(JSONObject().apply {
                        put("label", "SD / OTG #${idx + 1}")
                        put("path", dir.absolutePath)
                        put("free", freeGb)
                        put("total", totalGb)
                    })
                    if (extSummary == "None") extSummary = "$freeGb Free"
                } catch (_: Exception) {}
            }
        }

        // MediaCodec hardware capabilities
        val codecCaps = detectMediaCodecs()

        return JSONObject().apply {
            put("model", model)
            put("soc", soc)
            put("totalCores", totalCores)
            put("cpuSummary", cpuSummary)
            put("tasksetPerfMask", tasksetHex)
            put("ramTotal", totalRamGb)
            put("ramAvailable", availRamGb)
            put("internalFree", intFreeGb)
            put("externalSdOtg", extSummary)
            put("removableVolumes", removableVolumes)
            put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a")
            put("androidVersion", Build.VERSION.RELEASE ?: "")
            put("codecs", codecCaps)
        }
    }

    private fun detectCpuClusters(): List<CpuCluster> {
        val freqMap = mutableMapOf<Long, MutableList<Int>>()
        val cpuCount = Runtime.getRuntime().availableProcessors()
        for (i in 0 until cpuCount) {
            val f = File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq")
            val khz = try {
                if (f.exists()) f.readText().trim().toLongOrNull() ?: 0L else 0L
            } catch (_: Exception) {
                0L
            }
            if (khz > 0L) {
                freqMap.getOrPut(khz) { mutableListOf() }.add(i)
            }
        }
        return freqMap.entries
            .sortedByDescending { it.key }
            .map { CpuCluster(it.key, it.value) }
    }

    private fun detectMediaCodecs(): JSONObject {
        val list = MediaCodecList(MediaCodecList.ALL_CODECS)
        var h264HwDec = false
        var h264HwEnc = false
        var av1HwEnc = false
        var h264_10bitHwDec = false
        var hevc10bitHwDec = false
        var hevcHwEnc = false
        var av1HwDec = false

        for (info in list.codecInfos) {
            val isHw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.isHardwareAccelerated else !info.name.contains("omx.google", true)
            if (!isHw) continue

            for (type in info.supportedTypes) {
                val caps = try { info.getCapabilitiesForType(type) } catch (_: Exception) { continue }
                if (type.equals("video/avc", true) && info.isEncoder) { h264HwEnc = true }
                if (!info.isEncoder && type.equals("video/avc", true)) {
                    h264HwDec = true
                    if (caps.profileLevels.any {
                            it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileHigh10
                        }) {
                        h264_10bitHwDec = true
                    }
                }
                if (type.equals("video/hevc", true)) {
                    if (info.isEncoder) hevcHwEnc = true
                    if (!info.isEncoder && caps.profileLevels.any {
                            it.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10 ||
                                it.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10
                        }) {
                        hevc10bitHwDec = true
                    }
                }
                if (type.equals("video/av01", true)) {
                    if (info.isEncoder) av1HwEnc = true else av1HwDec = true
                }
            }
        }

        return JSONObject().apply {
            put("h264HwDecode", h264HwDec)
            put("h264_10bitHwDecode", h264_10bitHwDec)
            put("hevc10bitHwDecode", hevc10bitHwDec)
            put("hevcHwEncode", hevcHwEnc)
            put("h264HwEncode", h264HwEnc)
            put("av1HwDecode", av1HwDec)
            put("av1HwEncode", av1HwEnc)
        }
    }
}
