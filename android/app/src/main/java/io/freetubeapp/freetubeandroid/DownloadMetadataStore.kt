package io.freetubeapp.freetubeandroid

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

class DownloadMetadataStore(context: Context) : SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE $TABLE (" +
                "$ID TEXT PRIMARY KEY NOT NULL," +
                "$JSON TEXT NOT NULL," +
                "$UPDATED INTEGER NOT NULL," +
                "$SCHEMA INTEGER NOT NULL)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE $TABLE ADD COLUMN $SCHEMA INTEGER NOT NULL DEFAULT $METADATA_SCHEMA_VERSION")
            db.query(TABLE, arrayOf(ID, JSON), null, null, null, null, null).use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(ID)
                val jsonIndex = cursor.getColumnIndexOrThrow(JSON)
                while (cursor.moveToNext()) {
                    val id = cursor.getString(idIndex)
                    val record = runCatching { normalize(JSONObject(cursor.getString(jsonIndex)), id) }.getOrNull() ?: continue
                    db.update(TABLE, ContentValues().apply {
                        put(JSON, record.toString())
                        put(SCHEMA, METADATA_SCHEMA_VERSION)
                    }, "$ID = ?", arrayOf(id))
                }
            }
        }
    }

    @Synchronized
    fun read(): String {
        val result = JSONArray()
        readableDatabase.query(
            TABLE,
            arrayOf(JSON, ID),
            null,
            null,
            null,
            null,
            "$UPDATED ASC"
        ).use { cursor ->
            val jsonIndex = cursor.getColumnIndexOrThrow(JSON)
            while (cursor.moveToNext()) {
                runCatching {
                    result.put(normalize(JSONObject(cursor.getString(jsonIndex)), cursor.getString(cursor.getColumnIndexOrThrow(ID))))
                }
            }
        }
        return result.toString()
    }

    @Synchronized
    fun replace(serialized: String): Boolean {
        val records = JSONArray(serialized)
        val db = writableDatabase
        db.beginTransaction()
        return try {
            db.delete(TABLE, null, null)
            val now = System.currentTimeMillis()
            for (index in 0 until records.length()) {
                val raw = records.optJSONObject(index) ?: continue
                val id = raw.optString("downloadId").ifBlank { raw.optString("id") }
                if (id.isBlank()) continue
                val record = normalize(raw, id)
                db.insertOrThrow(TABLE, null, ContentValues().apply {
                    put(ID, id)
                    put(JSON, record.toString())
                    put(UPDATED, now + index)
                    put(SCHEMA, METADATA_SCHEMA_VERSION)
                })
            }
            db.setTransactionSuccessful()
            true
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun delete(downloadId: String): Boolean = writableDatabase.delete(TABLE, "$ID = ?", arrayOf(downloadId)) > 0

    override fun close() {
        super.close()
    }

    companion object {
        private const val DATABASE_NAME = "downloads.db"
        private const val DATABASE_VERSION = 2
        private const val METADATA_SCHEMA_VERSION = 1
        private const val TABLE = "download_metadata"
        private const val ID = "download_id"
        private const val JSON = "metadata_json"
        private const val UPDATED = "updated_at"
        private const val SCHEMA = "schema_version"

        private fun normalize(input: JSONObject, fallbackId: String): JSONObject = input.apply {
            put("schemaVersion", METADATA_SCHEMA_VERSION)
            put("downloadId", optString("downloadId").ifBlank { optString("id").ifBlank { fallbackId } })
            put("videoId", optString("videoId"))
            put("title", optString("title").ifBlank { optString("fileName").ifBlank { fallbackId } })
            put("thumbnail", optString("thumbnail"))
            put("selectedFormat", optString("selectedFormat"))
            put("engine", optString("engine").ifBlank { if (has("offlineUri")) "sabr" else "native" })
            put("status", optString("status").ifBlank { "queued" })
            put("phase", optString("phase").ifBlank { optString("status").ifBlank { "queued" } })
            put("sourceLocator", optString("sourceLocator").ifBlank { optString("localPath").ifBlank { optString("offlineUri") } })
            if (!has("progress")) put("progress", JSONObject.NULL)
            if (!has("error")) put("error", JSONObject.NULL)
            if (!has("createdAt")) put("createdAt", 0)
            put("updatedAt", optLong("updatedAt", System.currentTimeMillis()))
        }
    }
}
