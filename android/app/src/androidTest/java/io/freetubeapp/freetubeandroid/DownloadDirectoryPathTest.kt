package io.freetubeapp.freetubeandroid

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DownloadDirectoryPathTest {
    @Test
    fun formatsPrimaryStoragePath() {
        assertEquals("Internal storage/Download/Podcasts", formatExternalStorageDocumentId("primary:Download/Podcasts"))
    }

    @Test
    fun formatsOtherStorageVolume() {
        assertEquals("Storage (ABCD-1234)/Videos", formatExternalStorageDocumentId("ABCD-1234:Videos"))
    }
}
