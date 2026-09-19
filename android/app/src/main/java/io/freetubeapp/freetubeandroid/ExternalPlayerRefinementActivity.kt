package io.freetubeapp.freetubeandroid

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.ResultReceiver
import android.util.Log

class ExternalPlayerRefinementActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val sourceIntent = parcelable<Intent>(Intent.EXTRA_INTENT)
        val resultReceiver = parcelable<ResultReceiver>(Intent.EXTRA_RESULT_RECEIVER)
        val token = sourceIntent?.data?.path
            ?.substringAfterLast('/')
            ?.removeSuffix(".mp4")
            ?.removeSuffix(".mpd")

        Log.d("FreeTubeExternal", "refinement-activity token=${token?.take(8)}")
        if (sourceIntent == null || resultReceiver == null || token.isNullOrBlank()) {
            resultReceiver?.send(Activity.RESULT_CANCELED, Bundle())
            finish()
            return
        }

        ExternalPlayerRefinement.register(token, sourceIntent, resultReceiver)
    }

    private inline fun <reified T : android.os.Parcelable> parcelable(key: String): T? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(key, T::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(key) as? T
        }
    }
}
