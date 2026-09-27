package io.freetubeapp.freetubeandroid

import android.Manifest
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import kotlinx.coroutines.runBlocking
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class CoordinateFreeSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val appPackage = "io.freetubeapp.freetubeandroid"

    @Test
    fun notificationWorkerEndToEnd() {
        val context = instrumentation.targetContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.POST_NOTIFICATIONS)
        }
        val channelId = "UCabcdefghijklmnopqrstuv"
        val prefs = context.getSharedPreferences(SubscriptionNotificationWorker.PREFS, 0)
        val previousPrefs = prefs.all.mapValues { it.value as? String }
        prefs.edit().clear().putString(SubscriptionNotificationWorker.CHANNELS, "[\"$channelId\"]").commit()
        val manager = context.getSystemService(NotificationManager::class.java)
        val emptyFeed = feed()
        listOf("video-one", "video-two", "video-three", "video-four", "video-five").forEach { manager.cancel(it.hashCode()) }
        val firstFeed = feed("video-one" to "First video")
        val latestFeed = feed("video-three" to "Newest video", "video-two" to "Middle video", "video-one" to "First video")

        try {
            runBlocking { assertTrue(runWorker(context, emptyFeed) is ListenableWorker.Result.Success) }
            assertEquals("", prefs.getString("last_$channelId", null))
            assertTrue(manager.activeNotifications.none { it.id == "video-one".hashCode() })

            runBlocking { assertTrue(runWorker(context, firstFeed) is ListenableWorker.Result.Success) }
            assertNotNull(waitForNotification(manager, "video-one"))
            manager.cancel("video-one".hashCode())

            runBlocking { assertTrue(runWorker(context, latestFeed) is ListenableWorker.Result.Success) }
            assertNotNull(waitForNotification(manager, "video-two"))
            assertNotNull(waitForNotification(manager, "video-three"))
            val posted = manager.activeNotifications.associateBy { it.id }
            assertEquals("Newest video", posted["video-three".hashCode()]?.notification?.extras?.getString("android.title"))
            assertEquals("Middle video", posted["video-two".hashCode()]?.notification?.extras?.getString("android.title"))
            assertTrue(posted["video-three".hashCode()]?.notification?.contentIntent != null)

            runBlocking { assertTrue(runWorker(context, latestFeed) is ListenableWorker.Result.Success) }
            val repeated = manager.activeNotifications.associateBy { it.id }
            assertEquals("Repeated feed must not repost notification", posted["video-three".hashCode()]?.postTime, repeated["video-three".hashCode()]?.postTime)
            assertEquals("Repeated feed must not repost notification", posted["video-two".hashCode()]?.postTime, repeated["video-two".hashCode()]?.postTime)

            runBlocking { assertTrue(runWorker(context, "<feed><entry><title>Malformed</title></entry></feed>") is ListenableWorker.Result.Success) }
            assertEquals("video-three", prefs.getString("last_$channelId", null))
            runBlocking { assertTrue(runWorker(context, "<feed><entry></feed>") is ListenableWorker.Result.Retry) }
            assertEquals("video-three", prefs.getString("last_$channelId", null))

            prefs.edit().putString("last_$channelId", "background-old").commit()
            val workManager = WorkManager.getInstance(context)
            val request = OneTimeWorkRequestBuilder<SubscriptionNotificationWorker>()
                .setInputData(workDataOf(
                    SubscriptionNotificationWorker.TEST_FEED to feed(
                        "background-new" to "WorkManager test video",
                        "background-old" to "Previously seen video"
                    ),
                    SubscriptionNotificationWorker.TEST_NOTIFICATIONS_ENABLED to true
                ))
                .build()
            workManager.enqueue(request).result.get(10, TimeUnit.SECONDS)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            var workInfo = workManager.getWorkInfoById(request.id).get(10, TimeUnit.SECONDS)
            while (workInfo?.state?.isFinished != true && System.nanoTime() < deadline) {
                Thread.sleep(100)
                workInfo = workManager.getWorkInfoById(request.id).get(10, TimeUnit.SECONDS)
            }
            assertEquals(WorkInfo.State.SUCCEEDED, workInfo?.state)
            val backgroundNotification = waitForNotification(manager, "background-new")
            assertNotNull(backgroundNotification)
            assertEquals("WorkManager test video", backgroundNotification!!.notification.extras.getString("android.title"))
            prefs.edit().putString("last_$channelId", "video-three").commit()

            val permissionDeniedFeed = feed("video-four" to "Permission denied video", "video-three" to "Newest video")
            runBlocking { assertTrue(runWorker(context, permissionDeniedFeed, false) is ListenableWorker.Result.Success) }
            assertTrue(manager.activeNotifications.none { it.id == "video-four".hashCode() })
            runBlocking { assertTrue(runWorker(context, permissionDeniedFeed) is ListenableWorker.Result.Success) }
            val latestVideoId = "video-four"
            val latestNotification = manager.activeNotifications.single { it.id == latestVideoId.hashCode() }
            val monitor = instrumentation.addMonitor(MainActivity::class.java.name, null, false)
            latestNotification.notification.contentIntent.send()
            val activity = instrumentation.waitForMonitorWithTimeout(monitor, 10_000) as? MainActivity
            assertTrue("Notification should open MainActivity", activity != null)
            assertEquals(latestVideoId, activity?.intent?.data?.getQueryParameter("v"))
            instrumentation.removeMonitor(monitor)

            prefs.edit().putString(SubscriptionNotificationWorker.CHANNELS, "[]").commit()
            runBlocking { assertTrue(runWorker(context, feed("video-five" to "Opt-out video")) is ListenableWorker.Result.Success) }
            assertTrue(manager.activeNotifications.none { it.id == "video-five".hashCode() })
        } finally {
            listOf("video-one", "video-two", "video-three", "video-four", "video-five").forEach { manager.cancel(it.hashCode()) }
            prefs.edit().clear().apply {
                previousPrefs.forEach { (key, value) -> if (value != null) putString(key, value) }
            }.commit()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                instrumentation.uiAutomation.dropShellPermissionIdentity()
            }
        }
    }

    private fun waitForNotification(
        manager: NotificationManager,
        videoId: String
    ): android.service.notification.StatusBarNotification? {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            manager.activeNotifications.firstOrNull { it.id == videoId.hashCode() }?.let { return it }
            Thread.sleep(100)
        }
        return null
    }

    private suspend fun runWorker(
        context: android.content.Context,
        feed: String,
        notificationsEnabled: Boolean = true
    ): ListenableWorker.Result {
        val worker = TestListenableWorkerBuilder<SubscriptionNotificationWorker>(context)
            .setInputData(workDataOf(
                SubscriptionNotificationWorker.TEST_FEED to feed,
                SubscriptionNotificationWorker.TEST_NOTIFICATIONS_ENABLED to notificationsEnabled
            ))
            .build()
        return worker.doWork()
    }

    private fun feed(vararg videos: Pair<String, String>) = buildString {
        append("<feed xmlns:yt=\"http://www.youtube.com/xml/schemas/2015\"><author><name>Smoke channel</name></author>")
        videos.forEach { (id, title) ->
            append("<entry><yt:videoId>$id</yt:videoId><title>$title</title></entry>")
        }
        append("</feed>")
    }

    @Test
    fun backgroundNotificationWorkerWithoutPeriodicDelay() {
        val context = instrumentation.targetContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.POST_NOTIFICATIONS)
        }
        val channelId = "UCabcdefghijklmnopqrstuv"
        val videoId = "quick-background-smoke-video"
        val workName = "background_notification_smoke"
        val prefs = context.getSharedPreferences(SubscriptionNotificationWorker.PREFS, 0)
        val previousPrefs = prefs.all.mapValues { it.value as? String }
        val manager = context.getSystemService(NotificationManager::class.java)
        val workManager = WorkManager.getInstance(context)
        prefs.edit().clear()
            .putString(SubscriptionNotificationWorker.CHANNELS, "[\"$channelId\"]")
            .putString("last_$channelId", "periodic-smoke-old")
            .commit()

        try {
            device.pressHome()
            val request = OneTimeWorkRequestBuilder<SubscriptionNotificationWorker>()
                .setInitialDelay(10, TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(workDataOf(
                    SubscriptionNotificationWorker.TEST_FEED to feed(
                        videoId to "Background smoke test video",
                        "periodic-smoke-old" to "Previously seen video"
                    ),
                    SubscriptionNotificationWorker.TEST_NOTIFICATIONS_ENABLED to true
                ))
                .build()
            workManager.enqueueUniqueWork(workName, ExistingWorkPolicy.REPLACE, request)
                .result.get(10, TimeUnit.SECONDS)

            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
            var notification: android.service.notification.StatusBarNotification? = null
            while (notification == null && System.nanoTime() < deadline) {
                notification = manager.activeNotifications.firstOrNull { it.id == videoId.hashCode() }
                if (notification == null) Thread.sleep(TimeUnit.SECONDS.toMillis(10))
            }
            assertNotNull("Background WorkManager run did not post notification within 60 seconds", notification)
            assertEquals("Background smoke test video", notification!!.notification.extras.getString("android.title"))
            assertTrue("MainActivity must remain in background", device.currentPackageName != appPackage)
        } finally {
            workManager.cancelUniqueWork(workName)
            prefs.edit().clear().apply {
                previousPrefs.forEach { (key, value) -> if (value != null) putString(key, value) }
            }.commit()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                instrumentation.uiAutomation.dropShellPermissionIdentity()
            }
        }
    }

    @Test
    fun dataDirectoryMoveReset() {
        launchApp()
        launchSmokeAction("data_select")
        selectDirectoryInDocumentsUi()
        assertTrue(waitForMapping { it.contains("content://") })

        launchSmokeAction("data_reset")
        assertTrue(waitForMapping { it.contains("\"directory\":\"data://\"") })
    }

    private fun launchApp() {
        instrumentation.targetContext.startActivity(
            Intent(Intent.ACTION_MAIN)
                .setComponent(ComponentName(appPackage, "$appPackage.MainActivity"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        assertTrue(device.wait(Until.hasObject(By.pkg(appPackage)), 15_000))
        Thread.sleep(5_000)
    }

    private fun launchSmokeAction(action: String) {
        instrumentation.targetContext.startActivity(
            Intent("io.freetubeapp.freetubeandroid.TEST_SMOKE_ACTION")
                .setComponent(ComponentName(appPackage, "$appPackage.MainActivity"))
                .putExtra("action", action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        Thread.sleep(1_000)
    }

    private fun selectDirectoryInDocumentsUi() {
        assertTrue(device.wait(Until.gone(By.pkg(appPackage)), 15_000))
        val packageName = device.currentPackageName
        if (!packageName.contains("documentsui", ignoreCase = true)) {
            println("SKIP: unsupported DocumentsUI provider $packageName")
            assumeTrue(false)
        }

        val folderSelector = By.res(packageName, "item_dir")
        if (device.wait(Until.hasObject(folderSelector), 1_000)) {
            device.findObject(folderSelector).click()
        }

        val useFolderSelector = By.res("android", "button1")
        if (!device.wait(Until.hasObject(useFolderSelector), 1_000)) {
            println("SKIP: DocumentsUI use-folder action not found")
            return
        }
        device.findObject(useFolderSelector).click()
        val allowSelector = By.res("android", "button1").text("ALLOW")
        if (device.wait(Until.hasObject(allowSelector), 2_000)) {
            device.findObject(allowSelector).click()
        }
        assertTrue(device.wait(Until.hasObject(By.pkg(appPackage)), 15_000))
    }

    private fun waitForMapping(predicate: (String) -> Boolean): Boolean {
        repeat(30) {
            if (predicate(readMapping().replace("\\/", "/"))) return true
            Thread.sleep(500)
        }
        return false
    }

    private fun readMapping(): String {
        return device.executeShellCommand(
            "run-as $appPackage cat files/data/data-location.json"
        )
    }
}
