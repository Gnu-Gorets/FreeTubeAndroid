package io.freetubeapp.freetubeandroid

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
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
    private val listeners = CopyOnWriteArrayList<(JSONArray) -> Unit>()
    private val lock = Any()
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val preferences = context.getSharedPreferences("downloads", Context.MODE_PRIVATE)
    @Volatile private var wifiOnly = preferences.getBoolean(KEY_WIFI_ONLY, false)
    @Volatile private var concurrency = preferences.getInt(KEY_CONCURRENCY, 1).coerceIn(1, MAX_CONCURRENCY)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            synchronized(lock) {
                if (!storage.isNetworkAvailable(wifiOnly)) return
                missions.values.filter {
                    it.optString("status") == DownloadMission.STATUS_FAILED &&
                        it.optString("errorCode") == DownloadMission.ERROR_NETWORK_UNAVAILABLE
                }.forEach {
                    it.put("status", DownloadMission.STATUS_QUEUED)
                }
                persistLocked()
                startNextLocked()
            }
        }
    }

    init {
        connectivity.registerDefaultNetworkCallback(networkCallback)
        storage.loadMetadata().let { saved ->
            synchronized(lock) {
                for (index in 0 until saved.length()) {
                    val mission = saved.optJSONObject(index) ?: continue
                    if (!mission.optString("id").isNullOrBlank()) {
                        migratePartPaths(mission)
                        if (mission.optString("status") == DownloadMission.STATUS_DOWNLOADING ||
                            mission.optString("status") == DownloadMission.STATUS_POST_PROCESSING
                        ) {
                            mission.put("status", DownloadMission.STATUS_PAUSED)
                        }
                        if (mission.optString("status") == DownloadMission.STATUS_COMPLETED &&
                            !storage.outputExists(mission.optString("outputUri"))
                        ) {
                            mission.put("status", DownloadMission.STATUS_MISSING)
                            mission.put("errorCode", ERROR_MISSING_OUTPUT)
                            mission.put("error", "Completed file is no longer available")
                        }
                        missions[mission.getString("id")] = mission
                    }
                }
                storage.deleteOrphanTemporaryFiles(referencedTemporaryPathsLocked())
                persistLocked()
            }
            startNextLocked()
        }
    }

    fun enqueue(request: JSONObject): String {
        DownloadMission.validateRequest(request)
        val id = UUID.randomUUID().toString()
        val mission = JSONObject(request.toString()).apply {
            put("threads", optInt("threads", 1).coerceIn(1, DownloadMission.MAX_THREADS))
            put("id", id)
            put("status", DownloadMission.STATUS_QUEUED)
            put("temporaryPath", "")
            put("downloadedBytes", 0)
            put("totalBytes", -1)
            put("createdAt", System.currentTimeMillis())
            val parts = getJSONArray("parts")
            for (index in 0 until parts.length()) {
                val part = parts.getJSONObject(index)
                val temporaryFile = storage.createTemporaryFile(
                    id,
                    part.optString("id", "part-$index"),
                    part.optString("extension", "part")
                )
                part.put("temporaryPath", temporaryFile.absolutePath)
            }
        }
        synchronized(lock) {
            missions[id] = mission
            persistLocked()
            startNextLocked()
        }
        return id
    }

    fun snapshot(): JSONArray = synchronized(lock) { snapshotLocked() }

    fun settings(): JSONObject = JSONObject().apply {
        put("wifiOnly", wifiOnly)
        put("concurrency", concurrency)
    }

    fun updateSettings(settings: JSONObject) {
        val newWifiOnly = settings.optBoolean("wifiOnly", wifiOnly)
        val newConcurrency = settings.optInt("concurrency", concurrency).coerceIn(1, MAX_CONCURRENCY)
        synchronized(lock) {
            wifiOnly = newWifiOnly
            concurrency = newConcurrency
            preferences.edit()
                .putBoolean(KEY_WIFI_ONLY, wifiOnly)
                .putInt(KEY_CONCURRENCY, concurrency)
                .apply()
            startNextLocked()
        }
    }

    fun replaceUrls(id: String, request: JSONObject): Boolean {
        DownloadMission.validateRequest(request)
        synchronized(lock) {
            val mission = missions[id] ?: return false
            if (active.containsKey(id) || !mission.optBoolean("needsRefresh", false)) return false
            val oldParts = mission.getJSONArray("parts")
            val newParts = request.getJSONArray("parts")
            if (oldParts.length() != newParts.length()) return false
            for (index in 0 until oldParts.length()) {
                oldParts.getJSONObject(index).put("url", newParts.getJSONObject(index).getString("url"))
            }
            mission.put("needsRefresh", false)
            mission.remove("error")
            mission.remove("errorCode")
            mission.put("status", DownloadMission.STATUS_QUEUED)
            persistLocked()
            startNextLocked()
            return true
        }
    }

    fun addListener(listener: (JSONArray) -> Unit) {
        listeners.addIfAbsent(listener)
    }

    fun removeListener(listener: (JSONArray) -> Unit) {
        listeners.remove(listener)
    }

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

    fun retry(id: String): Boolean {
        synchronized(lock) {
            val mission = missions[id] ?: return false
            if (mission.optString("status") != DownloadMission.STATUS_FAILED) return false
            if (mission.optBoolean("needsRefresh", false)) return false
            mission.remove("error")
            mission.remove("errorCode")
            mission.remove("needsRefresh")
            mission.put("status", DownloadMission.STATUS_QUEUED)
            persistLocked()
            startNextLocked()
            return true
        }
    }

    fun delete(id: String): Boolean {
        synchronized(lock) {
            if (active.containsKey(id)) return false
            val mission = missions.remove(id) ?: return false
            storage.deleteTemporaryFile(File(mission.optString("temporaryPath")))
            mission.optString("outputUri").takeIf { it.isNotBlank() }?.let(storage::deleteOutput)
            persistLocked()
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
        connectivity.unregisterNetworkCallback(networkCallback)
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
        if (!storage.isNetworkAvailable(wifiOnly)) return
        while (active.size < concurrency) {
            val next = missions.values.firstOrNull {
                it.optString("status") == DownloadMission.STATUS_QUEUED && !active.containsKey(it.optString("id"))
            } ?: return
            if (!startMissionLocked(next.getString("id"))) return
        }
    }

    private fun migratePartPaths(mission: JSONObject) {
        val parts = mission.optJSONArray("parts") ?: return
        for (index in 0 until parts.length()) {
            val part = parts.optJSONObject(index) ?: continue
            if (part.optString("temporaryPath").isNotBlank()) continue
            val legacyPath = mission.optString("temporaryPath")
            val temporaryFile = if (index == 0 && legacyPath.isNotBlank()) {
                File(legacyPath)
            } else {
                storage.createTemporaryFile(
                    mission.getString("id"),
                    part.optString("id", "part-$index"),
                    part.optString("extension", "part")
                )
            }
            part.put("temporaryPath", temporaryFile.absolutePath)
        }
    }

    private fun referencedTemporaryPathsLocked(): Set<String> = missions.values.flatMap { mission ->
        val parts = mission.optJSONArray("parts") ?: JSONArray()
        (0 until parts.length()).mapNotNull { parts.optJSONObject(it)?.optString("temporaryPath")?.takeIf(String::isNotBlank) }
    }.toSet()

    private fun persistLocked() {
        val snapshot = snapshotLocked()
        storage.saveMetadata(snapshot)
        onChanged(snapshot)
        listeners.forEach { it(snapshot) }
    }

    companion object {
        private const val ERROR_MISSING_OUTPUT = "missing-output"
        private const val KEY_WIFI_ONLY = "wifiOnly"
        private const val KEY_CONCURRENCY = "concurrency"
        private const val MAX_CONCURRENCY = 3
    }

    private fun snapshotLocked(): JSONArray {
        val snapshot = JSONArray()
        missions.values.forEach { snapshot.put(JSONObject(it.toString())) }
        return snapshot
    }
}
