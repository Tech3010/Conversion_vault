package com.conversionvault.app.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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

class ConversionForegroundService : Service() {

    companion object {
        const val CHANNEL_SESSION_ID = "conversion_vault_session"
        const val CHANNEL_JOB_ID = "conversion_vault_engine"
        const val SESSION_NOTIFICATION_ID = 1000
        const val JOB_NOTIFICATION_ID = 1001

        const val ACTION_START_SESSION = "com.conversionvault.app.ACTION_START_SESSION"
        const val ACTION_START_QUEUE = "com.conversionvault.app.ACTION_START_QUEUE"
        const val ACTION_CANCEL_ACTIVE = "com.conversionvault.app.ACTION_CANCEL_ACTIVE"
        const val ACTION_EXIT_SESSION = "com.conversionvault.app.ACTION_EXIT_SESSION"
        const val ACTION_FINISH_APP = "com.conversionvault.app.ACTION_FINISH_APP"

        const val BROADCAST_PROGRESS = "com.conversionvault.app.BROADCAST_PROGRESS"
        const val EXTRA_EVENT_JSON = "event_json"
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var wakeLock: PowerManager.WakeLock? = null
    private var activeSession: FFmpegSession? = null
    private var activeJobId: String? = null
    private var isProcessing = false
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
            ACTION_START_QUEUE, null -> {
                startForegroundSafe("Engine session active · Processing queue")
                if (!isProcessing) {
                    isProcessing = true
                    processNextInQueue()
                }
            }
        }
        return START_STICKY
    }

    private fun processNextInQueue() {
        serviceScope.launch {
            val dao = VaultDatabase.getInstance(applicationContext).jobDao()
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            try {
                while (true) {
                    val job = dao.getNextQueuedJob() ?: break
                    activeJobId = job.id
                    try { if (wakeLock?.isHeld == false) wakeLock?.acquire(60 * 60 * 1000L) } catch (_: Throwable) {}

                    val running = job.copy(status = "RUNNING", updatedAt = System.currentTimeMillis())
                    dao.upsertJob(running)
                    emitEvent("job_started", job.id, 0, 0f, "")
                    updateSessionNotification("Engine session active · Encoding 1 job")
                    try {
                        nm.notify(JOB_NOTIFICATION_ID, buildJobNotification("Encoding ${File(job.outputPath).name}", "Starting FFmpeg...", 0, true))
                    } catch (_: Throwable) {}

                    val result = executeJobBlocking(running)
                    val finished = dao.getJobById(job.id) ?: running
                    if (finished.status != "CANCELLED") {
                        val finalStatus = if (result.first) "DONE" else "FAILED"
                        dao.upsertJob(
                            finished.copy(
                                status = finalStatus,
                                progressPct = if (result.first) 100 else finished.progressPct,
                                errorLog = if (result.first) "" else result.second,
                                updatedAt = System.currentTimeMillis()
                            )
                        )
                        if (result.first) {
                            try {
                                MediaScannerConnection.scanFile(applicationContext, arrayOf(job.outputPath), null, null)
                            } catch (_: Throwable) {}
                        }
                        emitEvent(if (result.first) "job_done" else "job_failed", job.id, if (result.first) 100 else finished.progressPct, 0f, result.second)

                        if (result.first && job.originalPolicy == "DELETE_AFTER_VERIFY") {
                            try {
                                val outFile = File(job.outputPath)
                                val inFile = File(job.inputPath)
                                if (outFile.exists() && outFile.length() > 0 && inFile.exists() && inFile.absolutePath != outFile.absolutePath) {
                                    inFile.delete()
                                }
                            } catch (_: Throwable) {}
                        }
                    }
                    activeJobId = null
                    activeSession = null
                }
            } catch (t: Throwable) {
                activeJobId?.let { id ->
                    try {
                        dao.getJobById(id)?.let { j ->
                            dao.upsertJob(j.copy(status = "FAILED", errorLog = "${t.javaClass.simpleName}: ${t.message}", updatedAt = System.currentTimeMillis()))
                        }
                    } catch (_: Throwable) {}
                }
            } finally {
                try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
                isProcessing = false
                try { nm.cancel(JOB_NOTIFICATION_ID) } catch (_: Throwable) {}
                updateSessionNotification("Engine session active · Ready")
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
        return executeFfmpegBlocking(job, ffmpegArgs)
    }

    private suspend fun executeFfmpegBlocking(job: JobEntity, resolvedCmdArgs: String): Pair<Boolean, String> = suspendCancellableCoroutine { cont ->
        val durationMs = job.durationMs.coerceAtLeast(1L)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        try {
            File(job.outputPath).parentFile?.mkdirs()
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
                        val pct = if (job.durationMs > 0) {
                            ((stats.time.toDouble() / durationMs.toDouble()) * 100.0).toInt().coerceIn(0, 99)
                        } else 0
                        val fps = stats.videoFps
                        val speed = String.format(Locale.US, "%.2fx", stats.speed)
                        nm.notify(JOB_NOTIFICATION_ID, buildJobNotification("Encoding ${File(job.outputPath).name}", "$pct% · ${fps.toInt()} fps · $speed", pct, false))
                        emitEvent("job_progress", job.id, pct, fps, speed)
                        val now = System.currentTimeMillis()
                        if (now - lastDbTickMs >= 900L) {
                            lastDbTickMs = now
                            serviceScope.launch {
                                try {
                                    val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                                    dao.getJobById(job.id)?.let { cur ->
                                        if (cur.status == "RUNNING") {
                                            dao.upsertJob(cur.copy(progressPct = pct, fps = fps, speed = speed, updatedAt = now))
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

    private fun emitEvent(type: String, jobId: String, pct: Int, fps: Float, detail: String) {
        try {
            val payload = JSONObject().apply {
                put("type", type)
                put("jobId", jobId)
                put("progress", pct)
                put("fps", fps)
                put("speed", detail)
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
