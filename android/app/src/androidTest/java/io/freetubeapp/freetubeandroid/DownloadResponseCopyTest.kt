package io.freetubeapp.freetubeandroid

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DownloadResponseCopyTest {
    @Test
    fun copiesExactResponseLength() {
        val output = ByteArrayOutputStream()
        val copied = copyDownloadResponse(ByteArrayInputStream(byteArrayOf(1, 2, 3)), output, 3, {})

        assertEquals(3L, copied)
        assertArrayEquals(byteArrayOf(1, 2, 3), output.toByteArray())
    }

    @Test
    fun rejectsShortResponse() {
        val output = ByteArrayOutputStream()

        assertThrows(IOException::class.java) {
            copyDownloadResponse(ByteArrayInputStream(byteArrayOf(1, 2)), output, 3, {})
        }
        assertArrayEquals(byteArrayOf(1, 2), output.toByteArray())
    }

    @Test
    fun rejectsExtraBytesWithoutWritingThem() {
        val output = ByteArrayOutputStream()

        assertThrows(IOException::class.java) {
            copyDownloadResponse(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), output, 3, {})
        }
        assertArrayEquals(byteArrayOf(), output.toByteArray())
    }

    @Test
    fun acceptsResumedAndShortFinalRanges() {
        val resumedOutput = ByteArrayOutputStream()
        val finalOutput = ByteArrayOutputStream()

        assertEquals(2L, copyDownloadResponse(ByteArrayInputStream(byteArrayOf(3, 4)), resumedOutput, 2, {}))
        assertEquals(1L, copyDownloadResponse(ByteArrayInputStream(byteArrayOf(5)), finalOutput, 1, {}))
        assertArrayEquals(byteArrayOf(3, 4), resumedOutput.toByteArray())
        assertArrayEquals(byteArrayOf(5), finalOutput.toByteArray())
    }

    @Test
    fun acceptsUnknownLengthResponse() {
        val output = ByteArrayOutputStream()
        val copied = copyDownloadResponse(ByteArrayInputStream(byteArrayOf(1, 2)), output, -1, {})

        assertEquals(2L, copied)
        assertArrayEquals(byteArrayOf(1, 2), output.toByteArray())
    }
}
