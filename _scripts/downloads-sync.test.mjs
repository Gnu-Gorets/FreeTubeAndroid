import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manager = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadManager.kt', import.meta.url), 'utf8')
const storage = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadStorage.kt', import.meta.url), 'utf8')
const bridge = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')

test('external output deletion is reconciled on every downloads snapshot', () => {
  assert.match(manager, /fun snapshot\(\): JSONArray = synchronized\(lock\) \{\s*if \(reconcileMissingOutputsLocked\(\)\) persistLocked\(\)/s)
  assert.match(manager, /mission\.put\("status", DownloadMission\.STATUS_MISSING\)/)
  assert.match(manager, /mission\.put\("errorCode", ERROR_MISSING_OUTPUT\)/)
  assert.match(manager, /!storage\.outputExists\(mission\.optString\("outputUri"\)\)/)
})

test('download updates are coalesced before reaching WebView', () => {
  assert.match(bridge, /DOWNLOAD_UPDATE_INTERVAL_MS = 250L/)
  assert.match(bridge, /pendingDownloadSnapshot/)
  assert.match(bridge, /mainHandler\.postDelayed\(downloadUpdateRunnable, DOWNLOAD_UPDATE_INTERVAL_MS\)/)
})

test('FreeTube deletion removes both MediaStore and SAF outputs', () => {
  assert.match(storage, /if \(parsed\.scheme == "content"\) contentResolver\.delete\(parsed, null, null\) > 0/)
  assert.match(storage, /DocumentFile\.fromSingleUri\(context, parsed\)\?\.delete\(\) == true/)
  assert.match(manager, /mission\.optString\("outputUri"\).*storage::deleteOutput/s)
})
