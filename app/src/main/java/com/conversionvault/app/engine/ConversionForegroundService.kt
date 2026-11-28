package com.conversionvault.app.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.content.pm.ServiceInfo
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.ReturnCode
import com.conversionvault.app.MainActivity
import com.conversionvault.app.data.JobEntity
import com.conversionvault.app.data.VaultDatabase
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

class ConversionForegroundService : Service() {

    companion object {
        const val CHANNEL_SESSION_ID = "conversion_vault_session"
        const val CHANNEL_JOB_ID = "conversion_vault_engine"
        const val SESSION_NOTIFICATION_ID = 1000
        const val JOB_NOTIFICATION_ID = 1001

        const val ACTION_START_SESSION = "com.conversionvault.app.ACTION_START_SESSION"
        const val ACTION_START_QUEUE = "com.conversionvault.app.ACTION_START_QUEUE"
        const val ACTION_CANCEL_ACTIVE = "com.conversionvault.app.ACTION_CANCEL_ACTIVE"
        const val ACTION_PAUSE_QUEUE = "com.conversionvault.app.ACTION_PAUSE_QUEUE"
        const val ACTION_RESUME_QUEUE = "com.conversionvault.app.ACTION_RESUME_QUEUE"
        const val ACTION_EXIT_SESSION = "com.conversionvault.app.ACTION_EXIT_SESSION"
        const val ACTION_FINISH_APP = "com.conversionvault.app.ACTION_FINISH_APP"

        const val BROADCAST_PROGRESS = "com.conversionvault.app.BROADCAST_PROGRESS"
        const val EXTRA_EVENT_JSON = "event_json"
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var wakeLock: PowerManager.WakeLock? = null
    private var activeSession: FFmpegSession? = null
    private var activeJobId: String? = null
    private val isProcessing = AtomicBoolean(false)
    private val queuePaused = AtomicBoolean(false)
    private var lastDbTickMs = 0L

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ConversionVault::EncodeWakeLock")
        } catch (_: Throwable) {}
    }

    private fun startForegroundSafe(statusText: String) {
        try {
            val notif = buildSessionNotification(statusText)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(
                    this,
                    SESSION_NOTIFICATION_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(SESSION_NOTIFICATION_ID, notif)
            }
        } catch (_: Throwable) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_EXIT_SESSION -> {
                try { activeSession?.let { FFmpegKit.cancel(it.sessionId) } } catch (_: Throwable) {}
                try {
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(JOB_NOTIFICATION_ID)
                } catch (_: Throwable) {}
                try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
                sendBroadcast(Intent(ACTION_FINISH_APP).setPackage(packageName))
                try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Throwable) {}
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_CANCEL_ACTIVE -> {
                try { activeSession?.let { FFmpegKit.cancel(it.sessionId) } } catch (_: Throwable) {}
                activeJobId?.let { id ->
                    serviceScope.launch {
                        try {
                            val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                            dao.getJobById(id)?.let { job ->
                                dao.upsertJob(job.copy(status = "CANCELLED", updatedAt = System.currentTimeMillis()))
                                emitEvent("job_cancelled", job.id, 0, 0f, "")
                            }
                        } catch (_: Throwable) {}
                    }
                }
                try {
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(JOB_NOTIFICATION_ID)
                } catch (_: Throwable) {}
                updateSessionNotification("Engine session active · Ready")
            }
            ACTION_START_SESSION -> {
                startForegroundSafe("Engine session active · Ready")
            }
            ACTION_PAUSE_QUEUE -> {
                queuePaused.set(true)
                try { activeSession?.let { FFmpegKit.cancel(it.sessionId) } } catch (_: Throwable) {}
                activeJobId?.let { id ->
                    serviceScope.launch {
                        try {
                            val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                            dao.getJobById(id)?.let { job ->
                                if (job.status == "RUNNING") {
                                    dao.upsertJob(job.copy(status = "PAUSED", updatedAt = System.currentTimeMillis()))
                                    emitEvent("job_paused", job.id, job.progressPct, 0f, "Paused")
                                }
                            }
                        } catch (_: Throwable) {}
                    }
                }
                try {
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(JOB_NOTIFICATION_ID)
                } catch (_: Throwable) {}
                updateSessionNotification("Conversion Engine paused · Tap Resume in Queue")
            }
            ACTION_RESUME_QUEUE -> {
                queuePaused.set(false)
                startForegroundSafe("Conversion Engine active · Resuming queue")
                serviceScope.launch {
                    try {
                        val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                        dao.getAllJobs().filter { it.status == "PAUSED" }.forEach { j ->
                            dao.upsertJob(j.copy(status = "QUEUED", progressPct = 0, updatedAt = System.currentTimeMillis()))
                        }
                    } catch (_: Throwable) {}
                    if (isProcessing.compareAndSet(false, true)) {
                        processNextInQueue()
                    }
                }
            }
            ACTION_START_QUEUE, null -> {
                queuePaused.set(false)
                startForegroundSafe("Conversion Engine active · Processing queue")
                if (isProcessing.compareAndSet(false, true)) {
                    processNextInQueue()
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun processNextInQueue() {
        serviceScope.launch {
            val dao = VaultDatabase.getInstance(applicationContext).jobDao()
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            try {
                // Recover any orphaned RUNNING jobs from a previous OS-killed session
                try {
                    dao.getAllJobs().filter { it.status == "RUNNING" }.forEach { stale ->
                        dao.upsertJob(stale.copy(status = "QUEUED", progressPct = 0, updatedAt = System.currentTimeMillis()))
                    }
                } catch (_: Throwable) {}

                var completedInRun = 0
                while (!queuePaused.get()) {
                    val job = dao.getNextQueuedJob() ?: break
                    activeJobId = job.id
                    try {
                        try { if (wakeLock?.isHeld == false) wakeLock?.acquire(60 * 60 * 1000L) } catch (_: Throwable) {}
                        val remaining = try { dao.getAllJobs().count { it.status == "QUEUED" || it.status == "RUNNING" } } catch (_: Throwable) { 1 }
                        val running = job.copy(status = "RUNNING", updatedAt = System.currentTimeMillis())
                        dao.upsertJob(running)
                        emitEvent("job_started", job.id, 0, 0f, "")
                        updateSessionNotification("Batch active · ${completedInRun + 1} of ${completedInRun + remaining}")
                        try {
                            nm.notify(
                                JOB_NOTIFICATION_ID,
                                buildJobNotification("(${completedInRun + 1}/${completedInRun + remaining}) ${File(job.outputPath).name}", "Starting engine...", 0, true)
                            )
                        } catch (_: Throwable) {}

                        val result = executeJobBlocking(running)
                        val finished = dao.getJobById(job.id) ?: running
                        val outFile = File(job.outputPath)

                        if (finished.status == "CANCELLED" || finished.status == "PAUSED" || queuePaused.get()) {
                            // Remove incomplete partial output on cancel or pause
                            try { if (outFile.exists() && outFile.absolutePath != File(job.inputPath).absolutePath) outFile.delete() } catch (_: Throwable) {}
                            if (queuePaused.get() && finished.status != "CANCELLED") {
                                dao.upsertJob(finished.copy(status = "PAUSED", progressPct = 0, updatedAt = System.currentTimeMillis()))
                                emitEvent("job_paused", job.id, 0, 0f, "Paused")
                                break
                            }
                        } else {
                            val verifiedOk = result.first && outFile.exists() && outFile.length() > 0L
                            if (!verifiedOk) {
                                // Remove incomplete/corrupt partial output so unplayable files are never left behind
                                try { if (outFile.exists() && outFile.absolutePath != File(job.inputPath).absolutePath) outFile.delete() } catch (_: Throwable) {}
                                try { getSharedPreferences("vault_settings", Context.MODE_PRIVATE).edit().putBoolean("engine_health_dirty", true).apply() } catch (_: Throwable) {}
                            }
                            val finalStatus = if (verifiedOk) "DONE" else "FAILED"
                            val errText = if (verifiedOk) "" else (result.second.ifBlank { "Output file empty or incomplete" })
                            dao.upsertJob(
                                finished.copy(
                                    status = finalStatus,
                                    progressPct = if (verifiedOk) 100 else finished.progressPct,
                                    errorLog = errText,
                                    updatedAt = System.currentTimeMillis()
                                )
                            )
                            if (verifiedOk) {
                                try {
                                    MediaScannerConnection.scanFile(applicationContext, arrayOf(job.outputPath), null, null)
                                } catch (_: Throwable) {}
                            }
                            emitEvent(if (verifiedOk) "job_done" else "job_failed", job.id, if (verifiedOk) 100 else finished.progressPct, 0f, errText)

                            if (verifiedOk && (job.originalPolicy.equals("DELETE_AFTER_VERIFY", true) || job.originalPolicy.equals("trash", true))) {
                                try {
                                    val inFile = File(job.inputPath)
                                    if (inFile.exists() && inFile.absolutePath != outFile.absolutePath) {
                                        if (inFile.delete()) {
                                            try {
                                                MediaScannerConnection.scanFile(applicationContext, arrayOf(inFile.absolutePath), null, null)
                                            } catch (_: Throwable) {}
                                        }
                                    }
                                } catch (_: Throwable) {}
                            }
                        }
                        completedInRun++
                    } catch (jobErr: Throwable) {
                        // Per-job catch: mark THIS job failed, delete partial file, and CONTINUE to all remaining queued jobs!
                        try {
                            val outFile = File(job.outputPath)
                            if (outFile.exists() && outFile.absolutePath != File(job.inputPath).absolutePath) outFile.delete()
                        } catch (_: Throwable) {}
                        try {
                            dao.getJobById(job.id)?.let { j ->
                                dao.upsertJob(j.copy(status = "FAILED", errorLog = "${jobErr.javaClass.simpleName}: ${jobErr.message}", updatedAt = System.currentTimeMillis()))
                            }
                            try { getSharedPreferences("vault_settings", Context.MODE_PRIVATE).edit().putBoolean("engine_health_dirty", true).apply() } catch (_: Throwable) {}
                            emitEvent("job_failed", job.id, 0, 0f, jobErr.message ?: "Job error")
                        } catch (_: Throwable) {}
                    } finally {
                        activeJobId = null
                        activeSession = null
                    }
                }
            } finally {
                try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
                isProcessing.set(false)
                try { nm.cancel(JOB_NOTIFICATION_ID) } catch (_: Throwable) {}
                // Safety re-check: if new jobs arrived (and queue is NOT paused), re-trigger once; otherwise stop service cleanly!
                var restarted = false
                try {
                    if (!queuePaused.get() && dao.getNextQueuedJob() != null && isProcessing.compareAndSet(false, true)) {
                        restarted = true
                        processNextInQueue()
                    }
                } catch (_: Throwable) {}
                if (!restarted) {
                    try {
                        ServiceCompat.stopForeground(this@ConversionForegroundService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    } catch (_: Throwable) {
                        @Suppress("DEPRECATION")
                        try { stopForeground(true) } catch (_: Throwable) {}
                    }
                    try { stopSelf() } catch (_: Throwable) {}
                }
            }
        }
    }

    private suspend fun executeJobBlocking(job: JobEntity): Pair<Boolean, String> {
        val inExt = File(job.inputPath).extension
        val outExt = File(job.outputPath).extension
        val isNativePhoto = job.commandArgs.trim().startsWith("NATIVE_PHOTO:") ||
            (job.mediaType.equals("Image", ignoreCase = true) &&
                NativePhotoEngine.isImageExtension(inExt) &&
                NativePhotoEngine.isImageExtension(outExt))

        var ffmpegArgs = job.commandArgs
        if (isNativePhoto) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val dao = VaultDatabase.getInstance(applicationContext).jobDao()
            val photoRes = NativePhotoEngine.convertImage(
                context = applicationContext,
                inputPath = job.inputPath,
                outputPath = job.outputPath,
                commandArgs = job.commandArgs
            ) { pct, stage ->
                try {
                    nm.notify(
                        JOB_NOTIFICATION_ID,
                        buildJobNotification("Photo Engine · ${File(job.outputPath).name}", "$pct% · $stage", pct, false)
                    )
                    emitEvent("job_progress", job.id, pct, 0f, stage)
                    val now = System.currentTimeMillis()
                    serviceScope.launch {
                        try {
                            dao.getJobById(job.id)?.let { cur ->
                                if (cur.status == "RUNNING") {
                                    dao.upsertJob(cur.copy(progressPct = pct, speed = "Native", updatedAt = now))
                                }
                            }
                        } catch (_: Throwable) {}
                    }
                } catch (_: Throwable) {}
            }
            when (photoRes) {
                is NativePhotoEngine.Result.Success -> return Pair(true, "")
                is NativePhotoEngine.Result.Failure -> return Pair(false, photoRes.error)
                is NativePhotoEngine.Result.FallbackToFfmpeg -> {
                    ffmpegArgs = photoRes.fallbackArgs
                }
            }
        }
        val settingsPrefs = applicationContext.getSharedPreferences("vault_settings", Context.MODE_PRIVATE)
        // Thermal Guard (>45°C Throttle): step down threads to 4 when battery temperature >= 45.0°C
        if (settingsPrefs.getBoolean("thermal_guard", true)) {
            try {
                val battIntent = applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                val tempTenths = battIntent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
                if (tempTenths >= 450) {
                    val safeThreads = if (tempTenths >= 480) 2 else 4
                    ffmpegArgs = if (ffmpegArgs.contains("-threads ")) {
                        ffmpegArgs.replace(Regex("-threads\\s+\\d+"), "-threads $safeThreads")
                    } else {
                        "-threads $safeThreads $ffmpegArgs"
                    }
                    emitEvent("job_progress", job.id, 1, 0f, "Thermal Guard (${tempTenths / 10.0}°C) · $safeThreads threads")
                }
            } catch (_: Throwable) {}
        }

        // MediaCodec Hardware Encoder Preference with automatic software fallback
        val hwPref = settingsPrefs.getString("hw_preference", "hw_fast") ?: "hw_fast"
        if (hwPref == "hw_fast" && (ffmpegArgs.contains("-c:v libx264") || ffmpegArgs.contains("-c:v libx265"))) {
            val hwCodec = if (ffmpegArgs.contains("-c:v libx265")) "hevc_mediacodec" else "h264_mediacodec"
            var hwArgs = ffmpegArgs
                .replace("-c:v libx264", "-c:v $hwCodec")
                .replace("-c:v libx265", "-c:v $hwCodec")
                .replace(Regex("-crf\\s+\\d+"), "-b:v 10M")
                .replace(Regex("-preset\\s+\\S+"), "").replace(Regex("-tune\\s+\\S+"), "")
            val hwRes = executeFfmpegBlocking(job, hwArgs)
            if (hwRes.first) return hwRes
            // Automatic fallback to software encoder if MediaCodec rejects pixel format/profile
            try { File(job.outputPath).delete() } catch (_: Throwable) {}
        }

        // Universal FFmpeg command sanitizer for AV1, VP9, 24-bit Audio, and MP4/Opus muxing
        var safeArgs = ffmpegArgs
            .replace("-sample_fmt s24", "-sample_fmt s32 -bits_per_raw_sample 24")
            .replace("-deadline realtime", "-deadline good -cpu-used 5 -row-mt 1")

        if (safeArgs.contains("libsvtav1")) {
            // SVT-AV1 requires numeric presets (0-13), not x264 string names, and does not support yuv422p or -tune
            safeArgs = safeArgs
                .replace(Regex("-preset\\s+(ultrafast|superfast|veryfast)"), "-preset 9")
                .replace(Regex("-preset\\s+(faster|fast)"), "-preset 8")
                .replace(Regex("-preset\\s+medium"), "-preset 6")
                .replace(Regex("-preset\\s+(slow|slower|veryslow)"), "-preset 5")
                .replace(Regex("-tune\\s+\\S+"), "")
                .replace("yuv422p", "yuv420p")
        }
        if (safeArgs.contains("libvpx-vp9")) {
            // VP9 uses -b:v 0 -deadline good -cpu-used 5 -row-mt 1 instead of -preset / -tune
            safeArgs = safeArgs
                .replace(Regex("-preset\\s+\\S+"), "-b:v 0 -deadline good -cpu-used 5 -row-mt 1")
                .replace(Regex("-tune\\s+\\S+"), "")
                .replace("yuv422p", "yuv420p")
            if (!safeArgs.contains("-b:v 0")) {
                safeArgs = safeArgs.replace("libvpx-vp9", "libvpx-vp9 -b:v 0 -deadline good -cpu-used 5 -row-mt 1")
            }
            if (safeArgs.contains("yuv420p10le") && !safeArgs.contains("-profile:v")) {
                safeArgs = safeArgs.replace("libvpx-vp9", "libvpx-vp9 -profile:v 2")
            }
        }
        if (safeArgs.contains("libopus") && job.outputPath.endsWith(".mp4", ignoreCase = true) && !safeArgs.contains("-strict -2")) {
            safeArgs = safeArgs.replace("-c:a libopus", "-strict -2 -c:a libopus")
        }

        if (Regex("\\b(https?|ftps?|rtmps?|rtsp|tcp|udp|srt|smb|sftp)://", RegexOption.IGNORE_CASE).containsMatchIn(safeArgs)) {
            return Pair(false, "Blocked non-offline network protocol in FFmpeg arguments")
        }
        val hardenedArgs = if (safeArgs.contains("-nostdin")) safeArgs else "-nostdin $safeArgs"
        val firstRes = executeFfmpegBlocking(job, hardenedArgs)
        if (firstRes.first) return firstRes

        // Automatic fallback if libsvtav1 is missing/unsupported -> try libaom-av1 (clean flags), then av1_mediacodec
        if (safeArgs.contains("libsvtav1")) {
            try { File(job.outputPath).delete() } catch (_: Throwable) {}
            val aomArgs = safeArgs
                .replace("libsvtav1", "libaom-av1")
                .replace(Regex("-preset\\s+\\S+"), "-cpu-used 8 -row-mt 1")
                .replace(Regex("-bf\\s+\\d+"), "")
                .replace(Regex("-maxrate\\s+\\S+"), "")
                .replace(Regex("-bufsize\\s+\\S+"), "")
                .replace(Regex("\\s+"), " ")
                .trim()
            val aomRes = executeFfmpegBlocking(job, aomArgs)
            if (aomRes.first) return aomRes

            try { File(job.outputPath).delete() } catch (_: Throwable) {}
            val mcArgs = safeArgs
                .replace("libsvtav1", "av1_mediacodec")
                .replace(Regex("-crf\\s+\\d+"), "-b:v 6M")
                .replace(Regex("-preset\\s+\\S+"), "")
                .replace(Regex("-bf\\s+\\d+"), "")
                .replace(Regex("-maxrate\\s+\\S+"), "")
                .replace(Regex("-bufsize\\s+\\S+"), "")
                .replace(Regex("\\s+"), " ")
                .trim()
            val mcRes = executeFfmpegBlocking(job, mcArgs)
            if (mcRes.first) return mcRes

            return Pair(false, "AV1 encode failed.\n• libsvtav1: ${firstRes.second.takeLast(180)}\n• libaom-av1: ${aomRes.second.takeLast(180)}\n• av1_mediacodec: ${mcRes.second.takeLast(180)}")
        }

        // Automatic fallback if 10-bit pixel format is rejected by encoder (e.g. 8-bit x264 or VP9 build) -> retry with 8-bit yuv420p
        if (safeArgs.contains("yuv420p10le") && (safeArgs.contains("libx264") || safeArgs.contains("libvpx-vp9"))) {
            try { File(job.outputPath).delete() } catch (_: Throwable) {}
            val bit8Args = safeArgs.replace("yuv420p10le", "yuv420p").replace("-profile:v 2", "")
            val bit8Res = executeFfmpegBlocking(job, bit8Args)
            if (bit8Res.first) return bit8Res
        }

        return firstRes
    }

    private fun resolveRealDurationMs(path: String, existingMs: Long): Long {
        if (existingMs > 0L) return existingMs
        val mmr = MediaMetadataRetriever()
        return try {
            mmr.setDataSource(path)
            mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } catch (_: Throwable) {
            0L
        } finally {
            try { mmr.release() } catch (_: Throwable) {}
        }
    }

    private suspend fun executeFfmpegBlocking(job: JobEntity, resolvedCmdArgs: String): Pair<Boolean, String> = suspendCancellableCoroutine { cont ->
        val realDurationMs = resolveRealDurationMs(job.inputPath, job.durationMs)
        if (realDurationMs > 0L && job.durationMs <= 0L) {
            serviceScope.launch {
                try {
                    val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                    dao.getJobById(job.id)?.let { cur ->
                        dao.upsertJob(cur.copy(durationMs = realDurationMs))
                    }
                } catch (_: Throwable) {}
            }
        }
        val durationMs = realDurationMs.coerceAtLeast(1L)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val outFileRef = File(job.outputPath)

        try {
            outFileRef.parentFile?.mkdirs()
            activeSession = FFmpegKit.executeAsync(
                resolvedCmdArgs,
                { session ->
                    val rc = session.returnCode
                    val ok = ReturnCode.isSuccess(rc)
                    val err = if (ok || ReturnCode.isCancel(rc)) "" else {
                        (session.failStackTrace ?: session.allLogsAsString ?: "FFmpeg failed (code $rc)").takeLast(800)
                    }
                    if (cont.isActive) cont.resumeWith(Result.success(Pair(ok, err)))
                },
                { _ -> },
                { stats ->
                    try {
                        val timeMs = stats.time.toLong().coerceAtLeast(0L)
                        val pct = if (realDurationMs > 0L) {
                            ((timeMs.toDouble() / durationMs.toDouble()) * 100.0).toInt().coerceIn(0, 99)
                        } else 0
                        val fps = stats.videoFps
                        val speed = String.format(Locale.US, "%.2fx", stats.speed)
                        val outBytes = try { if (outFileRef.exists()) outFileRef.length() else stats.size } catch (_: Throwable) { stats.size }
                        nm.notify(JOB_NOTIFICATION_ID, buildJobNotification("Encoding ${outFileRef.name}", "$pct% · ${fps.toInt()} fps · $speed", pct, false))
                        emitEvent("job_progress", job.id, pct, fps, speed, outBytes, timeMs, realDurationMs)
                        val now = System.currentTimeMillis()
                        if (now - lastDbTickMs >= 350L) {
                            lastDbTickMs = now
                            serviceScope.launch {
                                try {
                                    val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                                    dao.getJobById(job.id)?.let { cur ->
                                        if (cur.status == "RUNNING") {
                                            dao.upsertJob(cur.copy(progressPct = pct, fps = fps, speed = speed, durationMs = if (realDurationMs > 0L) realDurationMs else cur.durationMs, updatedAt = now))
                                        }
                                    }
                                } catch (_: Throwable) {}
                            }
                        }
                    } catch (_: Throwable) {}
                }
            )
        } catch (t: Throwable) {
            if (cont.isActive) {
                cont.resumeWith(Result.success(Pair(false, "${t.javaClass.simpleName}: ${t.message}")))
            }
        }
    }

    private fun emitEvent(
        type: String,
        jobId: String,
        pct: Int,
        fps: Float,
        detail: String,
        outBytes: Long = 0L,
        timeMs: Long = 0L,
        durationMs: Long = 0L
    ) {
        try {
            val payload = JSONObject().apply {
                put("type", type)
                put("jobId", jobId)
                put("progress", pct)
                put("fps", fps)
                put("speed", detail)
                put("outBytes", outBytes)
                put("timeMs", timeMs)
                put("durationMs", durationMs)
            }.toString()
            sendBroadcast(Intent(BROADCAST_PROGRESS).apply {
                setPackage(packageName)
                putExtra(EXTRA_EVENT_JSON, payload)
            })
        } catch (_: Throwable) {}
    }

    private fun updateSessionNotification(statusText: String) {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(SESSION_NOTIFICATION_ID, buildSessionNotification(statusText))
        } catch (_: Throwable) {}
    }

    private fun buildSessionNotification(statusText: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val exitIntent = PendingIntent.getService(
            this, 2, Intent(this, ConversionForegroundService::class.java).apply { action = ACTION_EXIT_SESSION },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_SESSION_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Conversion Vault")
            .setContentText(statusText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_lock_power_off, "Exit", exitIntent)
            .build()
    }

    private fun buildJobNotification(title: String, text: String, progress: Int, indeterminate: Boolean): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val cancelIntent = PendingIntent.getService(
            this, 1, Intent(this, ConversionForegroundService::class.java).apply { action = ACTION_CANCEL_ACTIVE },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_JOB_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .setProgress(100, progress, indeterminate)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent)
            .build()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_SESSION_ID, "Vault Active Session", NotificationManager.IMPORTANCE_LOW)
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_JOB_ID, "Conversion Progress", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
        serviceScope.cancel()
        super.onDestroy()
    }
}
