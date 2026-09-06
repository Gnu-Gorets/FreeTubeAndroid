package io.freetubeapp.freetubeandroid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import org.json.JSONArray

class DownloadService : Service() {
    private lateinit var manager: DownloadManager
    private val downloadListener: (JSONArray) -> Unit = ::updateNotification

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(null))
        manager = DownloadRuntime.manager(this)
        manager.addListener(downloadListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        manager.removeListener(downloadListener)
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateNotification(snapshot: JSONArray) {
        if (!::manager.isInitialized) return
        if (!hasRunningMission(snapshot)) {
            stopSelf()
            return
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(snapshot))
    }

    private fun hasRunningMission(snapshot: JSONArray): Boolean {
        for (index in 0 until snapshot.length()) {
            val status = snapshot.optJSONObject(index)?.optString("status")
            if (status == DownloadMission.STATUS_QUEUED ||
                status == DownloadMission.STATUS_DOWNLOADING ||
                status == DownloadMission.STATUS_POST_PROCESSING
            ) return true
        }
        return false
    }

    private fun buildNotification(snapshot: JSONArray?): Notification {
        var title = "FreeTube downloads"
        var text = "Waiting for downloads"
        var max = 0
        var progress = 0
        var indeterminate = true

        val active = snapshot?.let { findActiveMission(it) }
        if (active != null) {
            title = active.optString("title", title)
            val status = active.optString("status")
            text = when (status) {
                DownloadMission.STATUS_POST_PROCESSING -> "Processing"
                DownloadMission.STATUS_PAUSED -> "Paused"
                else -> "Downloading"
            }
            val total = active.optLong("totalBytes", -1L)
            val downloaded = active.optLong("downloadedBytes", 0L)
            if (total > 0) {
                max = 100
                progress = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                indeterminate = false
            }
        }

        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_media_notification_icon)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setOngoing(active != null)
            .setOnlyAlertOnce(true)
            .setContentIntent(downloadsPendingIntent())
            .setProgress(max, progress, indeterminate)
            .build()
    }

    private fun findActiveMission(snapshot: JSONArray): org.json.JSONObject? {
        for (index in 0 until snapshot.length()) {
            val mission = snapshot.optJSONObject(index) ?: continue
            if (mission.optString("status") in setOf(
                    DownloadMission.STATUS_QUEUED,
                    DownloadMission.STATUS_DOWNLOADING,
                    DownloadMission.STATUS_POST_PROCESSING,
                    DownloadMission.STATUS_PAUSED
                )) return mission
        }
        return null
    }

    private fun downloadsPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            putExtra(MainActivity.OPEN_DOWNLOADS_EXTRA, true)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            this,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun createNotificationChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW)
        )
    }

    companion object {
        private const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 2001
        private const val REQUEST_CODE = 2001
        const val ACTION_STOP = "io.freetubeapp.freetubeandroid.STOP_DOWNLOADS"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, DownloadService::class.java))
        }
    }
}
