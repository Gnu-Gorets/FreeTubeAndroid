package io.freetubeapp.freetubeandroid

import android.content.Context

internal object DownloadRuntime {
    @Volatile private var manager: DownloadManager? = null

    fun manager(context: Context): DownloadManager {
        return manager ?: synchronized(this) {
            manager ?: DownloadManager(context.applicationContext).also { manager = it }
        }
    }
}
