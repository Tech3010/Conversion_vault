package com.conversionvault.app.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.ReturnCode
import com.conversionvault.app.MainActivity
import com.conversionvault.app.data.JobEntity
import com.conversionvault.app.data.VaultDatabase
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File

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

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ConversionVault::EncodeWakeLock")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_EXIT_SESSION -> {
                activeSession?.let { FFmpegKit.cancel(it.sessionId) }
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(JOB_NOTIFICATION_ID)
                if (wakeLock?.isHeld == true) wakeLock?.release()
                sendBroadcast(Intent(ACTION_FINISH_APP).setPackage(packageName))
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_CANCEL_ACTIVE -> {
                activeSession?.let { FFmpegKit.cancel(it.sessionId) }
                activeJobId?.let { id ->
                    serviceScope.launch {
                        val dao = VaultDatabase.getInstance(applicationContext).jobDao()
                        dao.getJobById(id)?.let { job ->
                            dao.upsertJob(job.copy(status = "CANCELLED", updatedAt = System.currentTimeMillis()))
                            emitEvent("job_cancelled", job.id, 0, 0f, "")
                        }
                    }
                }
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(JOB_NOTIFICATION_ID)
                updateSessionNotification("Engine session active · Ready")
            }
            ACTION_START_SESSION -> {
                startForeground(SESSION_NOTIFICATION_ID, buildSessionNotification("Engine session active · Ready"))
            }
            ACTION_START_QUEUE, null -> {
                startForeground(SESSION_NOTIFICATION_ID, buildSessionNotification("Engine session active · Processing queue"))
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
            while (true) {
                val job = dao.getNextQueuedJob() ?: break
                activeJobId = job.id
                if (wakeLock?.isHeld == false) wakeLock?.acquire(60 * 60 * 1000L)

                val running = job.copy(status = "RUNNING", updatedAt = System.currentTimeMillis())
                dao.upsertJob(running)
                emitEvent("job_started", job.id, 0, 0f, "")
                updateSessionNotification("Engine session active · Encoding 1 job")
                nm.notify(JOB_NOTIFICATION_ID, buildJobNotification("Encoding ${File(job.outputPath).name}", "Starting FFmpeg...", 0, true))

                val success = executeJobBlocking(running)
                val finished = dao.getJobById(job.id) ?: running
                if (finished.status != "CANCELLED") {
                    val finalStatus = if (success) "DONE" else "FAILED"
                    dao.upsertJob(finished.copy(status = finalStatus, progressPct = if (success) 100 else finished.progressPct, updatedAt = System.currentTimeMillis()))
                    emitEvent(if (success) "job_done" else "job_failed", job.id, if (success) 100 else finished.progressPct, 0f, "")

                    if (success && job.originalPolicy == "DELETE_AFTER_VERIFY") {
                        val outFile = File(job.outputPath)
                        val inFile = File(job.inputPath)
                        if (outFile.exists() && outFile.length() > 0 && inFile.exists() && inFile.absolutePath != outFile.absolutePath) {
                            inFile.delete()
                        }
                    }
                }
                activeJobId = null
                activeSession = null
            }

            if (wakeLock?.isHeld == true) wakeLock?.release()
            isProcessing = false
            nm.cancel(JOB_NOTIFICATION_ID)
            updateSessionNotification("Engine session active · Ready")
        }
    }

    private suspend fun executeJobBlocking(job: JobEntity): Boolean = suspendCancellableCoroutine { cont ->
        val dao = VaultDatabase.getInstance(applicationContext).jobDao()
        val durationMs = job.durationMs.coerceAtLeast(1L)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        activeSession = FFmpegKit.executeAsync(
            job.commandArgs,
            { session ->
                val rc = session.returnCode
                val ok = ReturnCode.isSuccess(rc)
                if (!ok && !ReturnCode.isCancel(rc)) {
                    serviceScope.launch {
                        dao.getJobById(job.id)?.let { current ->
                            dao.upsertJob(current.copy(errorLog = session.failStackTrace ?: session.allLogsAsString.takeLast(800)))
                        }
                    }
                }
                if (cont.isActive) cont.resumeWith(Result.success(ok))
            },
            { _ -> },
            { stats ->
                val pct = if (job.durationMs > 0) {
                    ((stats.time.toDouble() / durationMs.toDouble()) * 100.0).toInt().coerceIn(0, 99)
                } else 0
                val fps = stats.videoFps
                val speed = String.format("%.2fx", stats.speed)
                nm.notify(JOB_NOTIFICATION_ID, buildJobNotification("Encoding ${File(job.outputPath).name}", "$pct% · ${fps.toInt()} fps · $speed", pct, false))
                emitEvent("job_progress", job.id, pct, fps, speed)
            }
        )
    }

    private fun emitEvent(type: String, jobId: String, pct: Int, fps: Float, speed: String) {
        val payload = JSONObject().apply {
            put("type", type)
            put("jobId", jobId)
            put("progress", pct)
            put("fps", fps)
            put("speed", speed)
        }.toString()
        sendBroadcast(Intent(BROADCAST_PROGRESS).apply {
            setPackage(packageName)
            putExtra(EXTRA_EVENT_JSON, payload)
        })
    }

    private fun updateSessionNotification(statusText: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(SESSION_NOTIFICATION_ID, buildSessionNotification(statusText))
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
        if (wakeLock?.isHeld == true) wakeLock?.release()
        serviceScope.cancel()
        super.onDestroy()
    }
}
