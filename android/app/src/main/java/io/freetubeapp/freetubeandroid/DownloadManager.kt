package io.freetubeapp.freetubeandroid

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class DownloadManager(
    context: Context,
    private val onChanged: (JSONArray) -> Unit = {}
) {
    private val storage = DownloadStorage(context)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val missions = LinkedHashMap<String, JSONObject>()
    private val active = HashMap<String, DownloadMission>()
    private val lock = Any()

    init {
        storage.loadMetadata().let { saved ->
            synchronized(lock) {
                for (index in 0 until saved.length()) {
                    val mission = saved.optJSONObject(index) ?: continue
                    if (!mission.optString("id").isNullOrBlank()) {
                        if (mission.optString("status") == DownloadMission.STATUS_DOWNLOADING ||
                            mission.optString("status") == DownloadMission.STATUS_POST_PROCESSING
                        ) {
                            mission.put("status", DownloadMission.STATUS_PAUSED)
                        }
                        missions[mission.getString("id")] = mission
                    }
                }
            }
            startNextLocked()
        }
    }

    fun enqueue(request: JSONObject): String {
        DownloadMission.validateRequest(request)
        val id = UUID.randomUUID().toString()
        val extension = request.optString("extension", "part")
        val temporaryFile = storage.createTemporaryFile(id, "progressive", extension)
        val mission = JSONObject(request.toString()).apply {
            put("id", id)
            put("status", DownloadMission.STATUS_QUEUED)
            put("temporaryPath", temporaryFile.absolutePath)
            put("downloadedBytes", 0)
            put("totalBytes", -1)
            put("createdAt", System.currentTimeMillis())
        }
        synchronized(lock) {
            missions[id] = mission
            persistLocked()
            startNextLocked()
        }
        return id
    }

    fun snapshot(): JSONArray = synchronized(lock) { snapshotLocked() }

    fun pause(id: String): Boolean {
        synchronized(lock) {
            val mission = missions[id] ?: return false
            val status = mission.optString("status")
            if (status == DownloadMission.STATUS_QUEUED) {
                mission.put("status", DownloadMission.STATUS_PAUSED)
                persistLocked()
                return true
            }
            if (status != DownloadMission.STATUS_DOWNLOADING) return false
            active[id]?.pause()
            return active.containsKey(id)
        }
    }

    fun resume(id: String): Boolean {
        synchronized(lock) {
            val mission = missions[id] ?: return false
            if (mission.optString("status") != DownloadMission.STATUS_PAUSED) return false
            mission.put("status", DownloadMission.STATUS_QUEUED)
            persistLocked()
            startNextLocked()
            return true
        }
    }

    fun cancel(id: String): Boolean {
        synchronized(lock) {
            val mission = missions[id] ?: return false
            val status = mission.optString("status")
            if (status == DownloadMission.STATUS_COMPLETED || status == DownloadMission.STATUS_CANCELED) return false
            active[id]?.cancel() ?: run {
                mission.put("status", DownloadMission.STATUS_CANCELED)
                storage.deleteTemporaryFile(File(mission.getString("temporaryPath")))
                persistLocked()
            }
            return true
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private fun startMissionLocked(id: String): Boolean {
        val mission = missions[id] ?: return false
        if (active.containsKey(id)) return false
        val downloadMission = DownloadMission(storage, mission) { changed ->
            synchronized(lock) {
                missions[id] = changed
                val isActive = changed.optString("status") in setOf(
                    DownloadMission.STATUS_DOWNLOADING,
                    DownloadMission.STATUS_POST_PROCESSING
                )
                if (!isActive) active.remove(id)
                persistLocked()
                if (!isActive) startNextLocked()
            }
        }
        active[id] = downloadMission
        executor.execute { downloadMission.run() }
        return true
    }

    private fun startNextLocked() {
        val next = missions.values.firstOrNull {
            it.optString("status") == DownloadMission.STATUS_QUEUED && !active.containsKey(it.optString("id"))
        } ?: return
        startMissionLocked(next.getString("id"))
    }

    private fun persistLocked() {
        val snapshot = snapshotLocked()
        storage.saveMetadata(snapshot)
        onChanged(snapshot)
    }

    private fun snapshotLocked(): JSONArray {
        val snapshot = JSONArray()
        missions.values.forEach { snapshot.put(JSONObject(it.toString())) }
        return snapshot
    }
}
