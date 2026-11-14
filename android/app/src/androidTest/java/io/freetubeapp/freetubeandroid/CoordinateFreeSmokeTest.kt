package io.freetubeapp.freetubeandroid

import android.content.ComponentName
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CoordinateFreeSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val appPackage = "io.freetubeapp.freetubeandroid"

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
