package io.freetubeapp.freetubeandroid

import io.freetubeapp.freetubeandroid.mux.Mp4FromDashWriter
import io.freetubeapp.freetubeandroid.mux.io.SharpStream
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel

/** Remuxes two DASH MP4 streams without MediaMuxer or decoding. */
internal object FastMp4Muxer {
    fun mux(files: List<File>, output: FileDescriptor, checkInterrupted: () -> Unit) =
        mux(files, ChannelSharpStream(FileOutputStream(output).channel, writable = true, checkInterrupted), checkInterrupted)

    fun mux(files: List<File>, output: File, checkInterrupted: () -> Unit) =
        mux(files, ChannelSharpStream(FileChannel.open(output.toPath(), java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.READ, java.nio.file.StandardOpenOption.WRITE), writable = true, checkInterrupted), checkInterrupted)

    private fun mux(files: List<File>, target: ChannelSharpStream, checkInterrupted: () -> Unit) {
        require(files.size == 2) { "Adaptive MP4 requires video and audio sources" }
        target.setLength(0)
        val sources = files.map { ChannelSharpStream(FileChannel.open(it.toPath()), writable = false, checkInterrupted) }
        try {
            Mp4FromDashWriter(sources[0], sources[1]).apply {
                parseSources()
                selectTracks(0, 0)
                build(target)
            }
            target.flush()
            checkInterrupted()
        } finally {
            sources.forEach(ChannelSharpStream::close)
            target.close()
        }
    }

    private class ChannelSharpStream(
        private val channel: FileChannel,
        private val writable: Boolean,
        private val checkInterrupted: () -> Unit
    ) : SharpStream() {
        override fun read(): Int {
            val buffer = ByteBuffer.allocate(1)
            return if (read(buffer.array(), 0, 1) < 0) -1 else buffer.array()[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray): Int = read(buffer, 0, buffer.size)

        override fun read(buffer: ByteArray, offset: Int, count: Int): Int {
            checkInterrupted()
            return channel.read(ByteBuffer.wrap(buffer, offset, count))
        }

        override fun skip(amount: Long): Long {
            checkInterrupted()
            val next = (channel.position() + amount).coerceAtMost(channel.size())
            val skipped = next - channel.position()
            channel.position(next)
            return skipped
        }

        override fun available(): Long = channel.size() - channel.position()

        override fun rewind() {
            channel.position(0)
        }

        override fun isClosed(): Boolean = !channel.isOpen

        override fun close() {
            channel.close()
        }

        override fun canRewind(): Boolean = channel.isOpen

        override fun canRead(): Boolean = !writable

        override fun canWrite(): Boolean = writable

        override fun canSetLength(): Boolean = writable

        override fun canSeek(): Boolean = channel.isOpen

        override fun write(value: Byte) = write(byteArrayOf(value))

        override fun write(buffer: ByteArray) = write(buffer, 0, buffer.size)

        override fun write(buffer: ByteArray, offset: Int, count: Int) {
            checkInterrupted()
            if (!writable) throw IOException("Read-only stream")
            val view = ByteBuffer.wrap(buffer, offset, count)
            while (view.hasRemaining()) channel.write(view)
        }

        override fun flush() = Unit

        override fun setLength(length: Long) {
            channel.truncate(length)
            channel.position(length)
        }

        override fun seek(offset: Long) {
            channel.position(offset)
        }

        override fun length(): Long = channel.size()
    }
}
