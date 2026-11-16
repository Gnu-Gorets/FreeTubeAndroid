import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const settings = await readFile(new URL('../src/renderer/store/modules/settings.js', import.meta.url), 'utf8')
const settingsView = await readFile(new URL('../src/renderer/components/DownloadsSettings/DownloadsSettings.vue', import.meta.url), 'utf8')
const manager = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadManager.kt', import.meta.url), 'utf8')
const activity = await readFile(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/MainActivity.kt', import.meta.url), 'utf8')
const smokeTest = await readFile(new URL('./android-smoke-test.sh', import.meta.url), 'utf8')

test('downloads defaults are Wi-Fi only and concurrency 3', () => {
  assert.match(settings, /downloadsWifiOnly: true/)
  assert.match(settings, /downloadsConcurrency: 3/)
  assert.match(manager, /KEY_WIFI_ONLY, true/)
  assert.match(manager, /KEY_CONCURRENCY, DEFAULT_CONCURRENCY/)
  assert.match(manager, /DEFAULT_CONCURRENCY = 3/)
})

test('downloads toggle smoke test checks enabled and disabled states', () => {
  assert.match(settingsView, /test-id="downloads-enabled"/)
  assert.match(activity, /action != "downloads_toggle"/)
  assert.match(activity, /SMOKE_DOWNLOADS_TOGGLE_TEST:\x27 \+ \(passed \? \x27PASS\x27 : \x27FAIL\x27\)/)
  assert.match(activity, /JSON\.parse\(window\.Android\.getDownloadSettings\(\)\)\.enabled === enabled/)
  assert.match(activity, /location\.hash = '#\/downloads'/)
  assert.match(activity, /setEnabled\(original\)/)
  assert.match(smokeTest, /downloads-toggle\) run_test downloads-toggle downloads_toggle/)
  assert.match(smokeTest, /run_web_smoke_action downloads_toggle/)
})

test('downloads concurrency offers values 1 through 5', () => {
  assert.match(settingsView, /:select-names="\['1', '2', '3', '4', '5'\]"/)
  assert.match(settingsView, /:select-values="\['1', '2', '3', '4', '5'\]"/)
  assert.match(manager, /MAX_CONCURRENCY = 5/)
  assert.match(manager, /coerceIn\(1, MAX_CONCURRENCY\)/)
})
