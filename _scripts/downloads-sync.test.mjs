import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manager = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadManager.kt', import.meta.url), 'utf8')
const storage = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadStorage.kt', import.meta.url), 'utf8')
const bridge = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')

test('external output deletion removes mission on every downloads snapshot', () => {
  assert.match(manager, /fun snapshot\(\): JSONArray = synchronized\(lock\) \{\s*val reconciled = reconcileMissingOutputsLocked\(\)\s*if \(reconciled\) persistLocked\(\)/s)
  assert.match(manager, /iterator\.remove\(\)/)
  assert.match(manager, /!storage\.outputExists\(mission\.optString\("outputUri"\)\)/)
})

test('MediaStore output existence requires readable content', () => {
  assert.match(storage, /val rowFound = cursor\.moveToFirst\(\)\s*val readable = rowFound && contentResolver\.openFileDescriptor\(parsed, "r"\)\?\.use \{ true \} == true/s)
})

test('Downloads tab refreshes after returning from file manager', async () => {
  const downloadsView = await readFile(new URL('../src/renderer/views/Downloads/Downloads.vue', import.meta.url), 'utf8')
  assert.match(downloadsView, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
  assert.match(downloadsView, /window\.addEventListener\('pageshow', handlePageShow\)/)
  assert.match(downloadsView, /window\.addEventListener\('app-resume', handleAppResume\)/)
  assert.match(downloadsView, /refreshDownloads\('app-resume'\)/)
})

test('download updates are coalesced before reaching WebView', () => {
  assert.match(bridge, /DOWNLOAD_UPDATE_INTERVAL_MS = 1000L/)
  assert.match(bridge, /pendingDownloadSnapshot/)
  assert.match(bridge, /mainHandler\.postDelayed\(downloadUpdateRunnable, DOWNLOAD_UPDATE_INTERVAL_MS\)/)
})

test('download progress persistence is throttled', () => {
  assert.match(manager, /PROGRESS_PERSIST_INTERVAL_MS = 1000L/)
  assert.match(manager, /if \(!isActive \|\| now - lastProgressPersistAt >= PROGRESS_PERSIST_INTERVAL_MS\) \{\s*lastProgressPersistAt = now\s*\n\s*persistLocked\(\)/s)
})

test('FreeTube deletion removes both MediaStore and SAF outputs', () => {
  assert.match(storage, /if \(parsed\.scheme == "content"\) contentResolver\.delete\(parsed, null, null\) > 0/)
  assert.match(storage, /DocumentFile\.fromSingleUri\(context, parsed\)\?\.delete\(\) == true/)
  assert.match(manager, /mission\.optString\("outputUri"\).*storage::deleteOutput/s)
})
