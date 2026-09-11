import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const watch = await readFile(new URL('../src/renderer/views/Watch/Watch.js', import.meta.url), 'utf8')
const settings = await readFile(new URL('../src/renderer/store/modules/settings.js', import.meta.url), 'utf8')
const downloadsSettings = await readFile(new URL('../src/renderer/components/DownloadsSettings/DownloadsSettings.vue', import.meta.url), 'utf8')
const downloadsView = await readFile(new URL('../src/renderer/views/Downloads/Downloads.vue', import.meta.url), 'utf8')
const localApi = await readFile(new URL('../src/renderer/helpers/api/local.js', import.meta.url), 'utf8')

const loadDownloadedMission = watch.match(/async loadDownloadedMission\(\) \{[\s\S]*?\n\s{4}\},\n\n\s{4}setViewingModeOnFirstLoad/)[0]

test('offline playback is limited to Downloads playlist', () => {
  assert.match(loadDownloadedMission, /status === 'completed'/)
  assert.match(loadDownloadedMission, /kind === 'video'/)
  assert.match(loadDownloadedMission, /item\.video\?\.id === this\.videoId/)
  assert.match(loadDownloadedMission, /item\.outputUri/)
  assert.match(loadDownloadedMission, /this\.playlistType !== 'downloaded'/)
  assert.doesNotMatch(loadDownloadedMission, /preferLocalDownloads|getDownloadsPreferLocal/)
})

test('Local watch-next metadata tolerates missing title text', () => {
  const parser = localApi.slice(localApi.indexOf('export function parseLocalWatchNextVideo'))
  assert.match(parser, /video\.title\?\.text\?\.trim\(\) \?\? ''/)
})

test('Translated caption metadata tolerates missing text fields', () => {
  assert.match(watch, /translationLanguage\.language_name\?\.text \?\? this\.t\('Locale Name'\)/)
  assert.match(watch, /trackToTranslate\.name\?\.text \?\? trackToTranslate\.language_code/)
})

test('Downloads Open uses internal offline playback route', () => {
  assert.match(downloadsView, /@click="open\(mission\.video\.id\)"/)
  assert.match(downloadsView, /path: `\/watch\/\$\{videoId\}`/)
  assert.match(downloadsView, /playlistType: 'downloaded'/)
  assert.doesNotMatch(downloadsView, /openDownload|openExternalLink/)
})

test('Prefer local files setting is removed', () => {
  assert.doesNotMatch(settings, /downloadsPreferLocal/)
  assert.doesNotMatch(downloadsSettings, /Prefer local files|preferLocal|DownloadsPreferLocal/)
})
