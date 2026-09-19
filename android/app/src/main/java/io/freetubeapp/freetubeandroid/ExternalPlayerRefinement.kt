package io.freetubeapp.freetubeandroid

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.ResultReceiver
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

object ExternalPlayerRefinement {
    private data class Pending(
        val sourceIntent: Intent,
        val resultReceiver: ResultReceiver
    )

    private val pending = ConcurrentHashMap<String, Pending>()
    private val ready = ConcurrentHashMap<String, Long>()

    fun register(token: String, sourceIntent: Intent, resultReceiver: ResultReceiver) {
        Log.d("FreeTubeExternal", "refinement-register token=${token.take(8)} component=${sourceIntent.component?.packageName}")
        if (System.currentTimeMillis() - (ready[token] ?: 0L) < 30_000) {
            ready.remove(token)
            dispatch(token, Pending(sourceIntent, resultReceiver))
        } else {
            ready.remove(token)
            pending[token] = Pending(sourceIntent, resultReceiver)
        }
    }

    fun markReady(token: String) {
        Log.d("FreeTubeExternal", "refinement-ready token=${token.take(8)}")
        pending.remove(token)?.let {
            dispatch(token, it)
        } ?: run {
            ready[token] = System.currentTimeMillis()
        }
    }

    private fun dispatch(token: String, request: Pending) {
        ready.remove(token)
        Log.d("FreeTubeExternal", "refinement-dispatch token=${token.take(8)}")
        request.resultReceiver.send(
            Activity.RESULT_OK,
            Bundle().apply {
                putParcelable(Intent.EXTRA_INTENT, request.sourceIntent)
            }
        )
    }
}
