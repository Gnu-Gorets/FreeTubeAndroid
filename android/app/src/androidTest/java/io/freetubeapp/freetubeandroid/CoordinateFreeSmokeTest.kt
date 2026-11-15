package io.freetubeapp.freetubeandroid

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CoordinateFreeSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val appPackage = "io.freetubeapp.freetubeandroid"

    @Test
    fun dataDirectoryMoveReset() {
        val originalMapping = readMapping()
        assertTrue(
            "Test requires the app to use internal data storage",
            originalMapping.isBlank() || originalMapping.contains("\"directory\":\"data://\"") || originalMapping.contains("\"directory\": \"data://\"")
        )

        var parentGrant: ParentGrant? = null
        var temporaryDirectoryName: String? = null
        try {
            val temporaryName = "FreeTubeSmokeTest-${UUID.randomUUID()}"
            temporaryDirectoryName = temporaryName
            val grant = createTemporaryParentTree(temporaryName)
            parentGrant = grant
            val parent = DocumentFile.fromTreeUri(instrumentation.targetContext, grant.uri)
                ?: error("Unable to open temporary parent directory")
            val temporaryDirectory = parent.createDirectory("data")
                ?: error("Unable to create temporary test directory")
            val initialUri = DocumentsContract.buildTreeDocumentUri(
                temporaryDirectory.uri.authority,
                DocumentsContract.getDocumentId(temporaryDirectory.uri)
            )

            launchApp()
            launchSmokeAction("data_select", initialUri.toString())
            selectCurrentDirectoryInDocumentsUi()
            assertTrue(waitForMapping { it.contains(temporaryName) })

            launchSmokeAction("data_reset")
            assertTrue(waitForMapping { it.contains("\"directory\":\"data://\"") })
        } finally {
            if (!isInternalDataMapping()) {
                launchApp()
                launchSmokeAction("data_reset")
                assertTrue("Failed to restore internal data directory", waitForMapping { isInternalDataMapping() })
            }
            parentGrant?.let { grant ->
                var cleanupComplete = temporaryDirectoryName == null
                try {
                    if (temporaryDirectoryName != null) {
                        val directory = DocumentFile.fromTreeUri(instrumentation.targetContext, grant.uri)
                            ?: error("Unable to reopen temporary directory for cleanup")
                        cleanupComplete = deleteRecursively(directory)
                        assertTrue("Failed to delete temporary test directory", cleanupComplete)
                    }
                } finally {
                    val contentResolver = instrumentation.targetContext.contentResolver
                    if (grant.releaseAfterTest && cleanupComplete && contentResolver.persistedUriPermissions.any { it.uri == grant.uri }) {
                        contentResolver.releasePersistableUriPermission(
                            grant.uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        )
                    }
                }
            }
        }
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

    private fun launchSmokeAction(action: String, query: String = "") {
        instrumentation.targetContext.startActivity(
            Intent("io.freetubeapp.freetubeandroid.TEST_SMOKE_ACTION")
                .setComponent(ComponentName(appPackage, "$appPackage.MainActivity"))
                .putExtra("action", action)
                .putExtra("query", query)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        Thread.sleep(1_000)
    }

    private fun selectCurrentDirectoryInDocumentsUi() {
        waitForDocumentsUi()
        val useFolderSelector = By.res("android", "button1")
        repeat(30) {
            if (device.hasObject(useFolderSelector) && device.findObject(useFolderSelector).isEnabled) {
                device.findObject(useFolderSelector).click()
                val allowSelector = By.res("android", "button1").text("ALLOW")
                if (device.wait(Until.hasObject(allowSelector), 2_000)) {
                    device.findObject(allowSelector).click()
                }
                assertTrue(device.wait(Until.hasObject(By.pkg(appPackage)), 15_000))
                return
            }
            Thread.sleep(500)
        }
        throw AssertionError("DocumentsUI did not enable Use this folder")
    }

    private fun waitForDocumentsUi() {
        repeat(30) {
            if (device.currentPackageName.contains("documentsui", ignoreCase = true)) return
            Thread.sleep(500)
        }
        throw AssertionError("DocumentsUI did not open")
    }

    private data class ParentGrant(val uri: Uri, val releaseAfterTest: Boolean)

    private fun createTemporaryParentTree(directoryName: String): ParentGrant {
        val contentResolver = instrumentation.targetContext.contentResolver
        val downloadsDocument = DocumentsContract.buildDocumentUri(
            "com.android.externalstorage.documents",
            "primary:Download"
        )
        launchApp()
        launchSmokeAction("data_test_parent", downloadsDocument.toString())
        waitForDocumentsUi()
        val documentsUiPackage = device.currentPackageName
        val createFolder = By.res(documentsUiPackage, "action_button").text("CREATE NEW FOLDER")
        assertTrue("DocumentsUI did not offer a new folder action", device.wait(Until.hasObject(createFolder), 5_000))
        device.findObject(createFolder).click()
        val folderName = By.res("android", "text1")
        assertTrue("New folder dialog did not open", device.wait(Until.hasObject(folderName), 5_000))
        device.findObject(folderName).setText(directoryName)
        device.findObject(By.res("android", "button1")).click()
        assertTrue("DocumentsUI did not create the temporary folder", device.wait(Until.gone(folderName), 5_000))
        selectCurrentDirectoryInDocumentsUi()
        val expectedDocumentId = "primary:Download/$directoryName"
        val permission = contentResolver.persistedUriPermissions.firstOrNull { item ->
            item.isReadPermission && item.isWritePermission &&
                runCatching { DocumentsContract.getTreeDocumentId(item.uri) == expectedDocumentId }.getOrDefault(false)
        } ?: error("DocumentsUI did not grant access to the temporary directory")
        return ParentGrant(permission.uri, releaseAfterTest = true)
    }

    private fun deleteRecursively(file: DocumentFile): Boolean {
        if (file.isDirectory && !file.listFiles().all(::deleteRecursively)) return false
        return file.delete()
    }

    private fun isInternalDataMapping(): Boolean {
        val mapping = readMapping()
        return mapping.isBlank() || mapping.contains("\"directory\":\"data://\"") || mapping.contains("\"directory\": \"data://\"")
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
            "run-as $appPackage cat files/data/data-location.json 2>/dev/null || true"
        )
    }
}
