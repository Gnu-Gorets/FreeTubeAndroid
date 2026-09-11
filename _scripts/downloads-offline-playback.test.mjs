import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const watch = await readFile(new URL('../src/renderer/views/Watch/Watch.js', import.meta.url), 'utf8')
const settings = await readFile(new URL('../src/renderer/store/modules/settings.js', import.meta.url), 'utf8')
const downloadsSettings = await readFile(new URL('../src/renderer/components/DownloadsSettings/DownloadsSettings.vue', import.meta.url), 'utf8')

const loadDownloadedMission = watch.match(/async loadDownloadedMission\(\) \{[\s\S]*?\n\s{4}\},\n\n\s{4}setViewingModeOnFirstLoad/)[0]

test('offline playback is limited to Downloads playlist', () => {
  assert.match(loadDownloadedMission, /status === 'completed'/)
  assert.match(loadDownloadedMission, /kind === 'video'/)
  assert.match(loadDownloadedMission, /item\.video\?\.id === this\.videoId/)
  assert.match(loadDownloadedMission, /item\.outputUri/)
  assert.match(loadDownloadedMission, /this\.playlistType !== 'downloaded'/)
  assert.doesNotMatch(loadDownloadedMission, /preferLocalDownloads|getDownloadsPreferLocal/)
})

test('Prefer local files setting is removed', () => {
  assert.doesNotMatch(settings, /downloadsPreferLocal/)
  assert.doesNotMatch(downloadsSettings, /Prefer local files|preferLocal|DownloadsPreferLocal/)
})
