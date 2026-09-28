package io.freetubeapp.freetubeandroid

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.NetworkType
import androidx.work.Operation
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.net.HttpURLConnection
import java.net.URL

class SubscriptionNotificationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private data class Video(val id: String, val title: String)
    private data class Feed(val channelName: String, val videos: List<Video>)

    override suspend fun doWork(): Result = workerMutex.withLock { runWorker() }

    private suspend fun runWorker(): Result {
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val channels = try { JSONArray(prefs.getString(CHANNELS, "[]")) } catch (_: Exception) { return Result.failure() }
        if (channels.length() == 0) return Result.success()
        val isDebuggable = applicationContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
        val testFeed = if (isDebuggable) inputData.getString(TEST_FEED) else null
        val testPermissionOverride = if (isDebuggable && inputData.keyValueMap.containsKey(TEST_NOTIFICATIONS_ENABLED)) {
            inputData.getBoolean(TEST_NOTIFICATIONS_ENABLED, false)
        } else null

        var hadFailures = false
        for (i in 0 until channels.length()) {
            val channelId = channels.optString(i)
            if (!channelId.matches(Regex("UC[a-zA-Z0-9_-]{22}"))) continue
            try {
                val feed = testFeed?.let(::parseFeed) ?: fetchFeed(channelId)
                val newest = feed.videos.firstOrNull()
                val key = "last_$channelId"
                val previous = prefs.getString(key, null)
                if (previous == null) {
                    prefs.edit().putString(key, newest?.id.orEmpty()).apply()
                } else if (newest != null && previous != newest.id) {
                    val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    val runtimePermissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                        applicationContext.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED
                    val channelImportance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        manager.getNotificationChannel(CHANNEL_ID)?.importance
                    } else null
                    val notificationsAllowed = testPermissionOverride ?: (
                        runtimePermissionGranted && manager.areNotificationsEnabled() &&
                            isNotificationChannelEnabled(channelImportance)
                        )
                    if (notificationsAllowed) {
                        val previousIndex = feed.videos.indexOfFirst { it.id == previous }
                        val newVideos = when {
                            previous.isEmpty() -> listOf(newest)
                            previousIndex >= 0 -> feed.videos.take(previousIndex)
                            else -> listOf(newest)
                        }
                        newVideos.asReversed().forEach { video ->
                            postNotification(applicationContext, channelId, video.id, video.title, feed.channelName)
                        }
                        prefs.edit().putString(key, newest.id).apply()
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Feed check failed: ${error.javaClass.simpleName}", error)
                hadFailures = true
            }
        }
        return if (hadFailures) Result.retry() else Result.success()
    }

    private fun fetchFeed(channelId: String): Feed {
        val connection = URL("https://www.youtube.com/feeds/videos.xml?channel_id=$channelId")
            .openConnection() as HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        connection.setRequestProperty("User-Agent", "Mozilla/5.0")
        try {
            require(connection.responseCode in 200..299) { "Feed request failed: ${connection.responseCode}" }
            return parseFeed(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    private fun parseFeed(xml: String): Feed {
        val parser = XmlPullParserFactory.newInstance().newPullParser()
        parser.setInput(xml.reader())
        var event = parser.eventType
        var inEntry = false
        var channelName = ""
        val videos = mutableListOf<Video>()
        var videoId = ""
        var title = ""
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG) {
                when {
                    parser.name == "entry" -> inEntry = true
                    parser.name == "name" && !inEntry -> channelName = parser.nextText()
                    inEntry && parser.name.substringAfterLast(':') == "videoId" -> videoId = parser.nextText()
                    inEntry && parser.name == "title" -> title = parser.nextText()
                }
            } else if (event == XmlPullParser.END_TAG && parser.name == "entry") {
                if (videoId.isNotBlank()) videos.add(Video(videoId, title))
                inEntry = false
                videoId = ""
                title = ""
            }
            event = parser.next()
        }
        return Feed(channelName, videos)
    }

    companion object {
        internal fun isNotificationChannelEnabled(importance: Int?) =
            importance != NotificationManager.IMPORTANCE_NONE

        fun postNotification(context: Context, channelId: String, videoId: String, title: String, channelName: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, context.getString(R.string.new_video_notification_channel), NotificationManager.IMPORTANCE_DEFAULT))
        }
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = android.net.Uri.parse("https://www.youtube.com/watch?v=$videoId")
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context, videoId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_media_notification_icon)
            .setContentTitle(title.ifBlank { context.getString(R.string.new_video_notification_fallback_title) })
            .setContentText(channelName.ifBlank { channelId })
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        manager.notify(videoId.hashCode(), notification)
        }

        fun restoreSchedule(context: Context): Operation? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val saved = try { JSONArray(prefs.getString(CHANNELS, "[]")) } catch (_: Exception) { return null }
            return if (saved.length() > 0) syncSubscriptions(context, saved) else null
        }

        fun syncSubscriptions(context: Context, channelIds: JSONArray): Operation {
            val appContext = context.applicationContext
            val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val normalizedIds = (0 until channelIds.length()).map { channelIds.optString(it) }.distinct().sorted()
            val normalized = JSONArray(normalizedIds)
            val previousIds = try {
                val previous = JSONArray(prefs.getString(CHANNELS, "[]"))
                (0 until previous.length()).map { previous.optString(it) }
            } catch (_: Exception) { emptyList() }
            val changed = previousIds.sorted() != normalizedIds
            if (changed) {
                val removedIds = previousIds - normalizedIds.toSet()
                prefs.edit().apply {
                    putString(CHANNELS, normalized.toString())
                    removedIds.forEach { remove("last_$it") }
                }.apply()
            }
            val workManager = WorkManager.getInstance(appContext)
            if (normalizedIds.isEmpty()) {
                workManager.cancelUniqueWork(INITIAL_WORK)
                return workManager.cancelUniqueWork(UNIQUE_WORK)
            }
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            if (changed) {
                val initialRequest = OneTimeWorkRequestBuilder<SubscriptionNotificationWorker>()
                    .setConstraints(constraints)
                    .build()
                workManager.enqueueUniqueWork(INITIAL_WORK, ExistingWorkPolicy.REPLACE, initialRequest)
            }
            val periodicRequest = PeriodicWorkRequestBuilder<SubscriptionNotificationWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            return workManager.enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, periodicRequest)
        }

        private const val TAG = "FreeTubeNotifications"
        const val PREFS = "subscription_notifications"
        const val CHANNELS = "channel_ids"
        const val CHANNEL_ID = "new_videos"
        const val UNIQUE_WORK = "subscription_notifications"
        const val INITIAL_WORK = "subscription_notifications_initial"
        const val TEST_FEED = "test_feed"
        const val TEST_NOTIFICATIONS_ENABLED = "test_notifications_enabled"
        // ponytail: process-local lock; persist only if workers move to another app process.
        private val workerMutex = Mutex()
    }
}
