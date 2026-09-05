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
                "$UPDATED INTEGER NOT NULL)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    @Synchronized
    fun read(): String {
        val result = JSONArray()
        readableDatabase.query(
            TABLE,
            arrayOf(JSON),
            null,
            null,
            null,
            null,
            "$UPDATED ASC"
        ).use { cursor ->
            val jsonIndex = cursor.getColumnIndexOrThrow(JSON)
            while (cursor.moveToNext()) result.put(JSONObject(cursor.getString(jsonIndex)))
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
                val record = records.optJSONObject(index) ?: continue
                val id = record.optString("downloadId").ifBlank { record.optString("id") }
                if (id.isBlank()) continue
                db.insertOrThrow(TABLE, null, ContentValues().apply {
                    put(ID, id)
                    put(JSON, record.toString())
                    put(UPDATED, now + index)
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
        private const val DATABASE_VERSION = 1
        private const val TABLE = "download_metadata"
        private const val ID = "download_id"
        private const val JSON = "metadata_json"
        private const val UPDATED = "updated_at"
    }
}
