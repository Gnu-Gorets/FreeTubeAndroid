import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { getDownloadNotificationId, getDownloadNotificationPayload } from '../src/renderer/helpers/android/download-notification.mjs'
import { filterDownloads } from '../src/renderer/helpers/android/download-search.mjs'
import { digitsOnly } from '../src/renderer/helpers/android/download-settings.mjs'

test('notification IDs are stable and distinct', () => {
  assert.equal(getDownloadNotificationId('download-1'), getDownloadNotificationId('download-1'))
  assert.notEqual(getDownloadNotificationId('download-1'), getDownloadNotificationId('download-2'))
})

test('concurrency input keeps digits only', () => {
  assert.equal(digitsOnly('12abc3'), '123')
  assert.equal(digitsOnly(''), '')
})

test('download search matches metadata and file path', () => {
  const downloads = [
    { title: 'Alpha video', localPath: 'data://alpha.mp4', status: 'completed' },
    { title: 'Beta video', localPath: 'data://beta.mp4', status: 'paused' }
  ]
  assert.deepEqual(filterDownloads(downloads, 'BETA'), [downloads[1]])
  assert.deepEqual(filterDownloads(downloads, 'alpha.mp4'), [downloads[0]])
  assert.equal(filterDownloads(downloads, '').length, 2)
})

test('downloading notification has pause and cancel actions', () => {
  assert.deepEqual(getDownloadNotificationPayload({ downloadId: '1', title: '480p', status: 'downloading', progress: 0.25, received: 25, total: 100, speedBps: 50 }), {
    downloadId: '1', title: '480p', text: 'Downloading 25% · 25 / 100 · 50/s', progress: 25, actions: ['pause', 'cancel']
  })
})

test('Android notification defines separate action intents', () => {
  const source = readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
  for (const action of ['pause', 'resume', 'retry', 'cancel']) assert.match(source, new RegExp(`downloadAction\\(downloadId, "[^\\"]+", "${action}"\\)`))
  assert.ok(source.includes('downloadNotificationId("$downloadId:$action")'))
  assert.ok(source.includes('notificationManager.cancel(downloadNotificationId(downloadId))'))
})

test('Android default downloads use public Freetube folder', () => {
  const source = readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
  assert.match(source, /RELATIVE_PATH, "\$\{Environment\.DIRECTORY_DOWNLOADS\}\/FreeTube"/)
  assert.match(source, /IS_PENDING, 1/)
})

test('download Settings names native file directory scope', () => {
  const locale = readFileSync(new URL('../static/locales/en-US.yaml', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../src/renderer/components/DownloadsSettings.vue', import.meta.url), 'utf8')
  assert.ok(locale.includes("Download folder: 'Native file download folder: {directory}'"))
  assert.ok(locale.includes('Native only: Used for native file downloads. SABR offline storage stays inside the app.'))
  assert.ok(locale.includes('Concurrent downloads: Concurrent SABR and native downloads'))
  assert.ok(settings.includes("t('Downloads.Settings.Native only')"))
})

test('directory reset and legacy migration use canonical default', () => {
  const source = readFileSync(new URL('../src/renderer/components/DownloadsSettings.vue', import.meta.url), 'utf8')
  assert.ok(source.includes('if (directory.value !== savedDirectory) localStorage.setItem'))
  assert.ok(source.includes('function resetDirectory()'))
  assert.ok(source.includes('directory.value = DEFAULT_DIRECTORY'))
  assert.ok(source.includes('localStorage.setItem(\'freetube-download-directory\', DEFAULT_DIRECTORY)'))
  assert.ok(source.includes('window.dispatchEvent(new CustomEvent(\'download-settings-changed\'))'))
})

test('MediaStore target uses Android Q pending publication lifecycle', () => {
  const source = readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt', import.meta.url), 'utf8')
  assert.ok(source.includes('Build.VERSION_CODES.Q'))
  assert.ok(source.includes('MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)'))
  assert.ok(source.includes('put(MediaStore.MediaColumns.IS_PENDING, 1)'))
  assert.ok(service.includes('put(MediaStore.MediaColumns.IS_PENDING, 0)'))
})

test('SAF directory URI keeps permission and creates a writable target', () => {
  const source = readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
  assert.ok(source.includes('Intent.ACTION_OPEN_DOCUMENT_TREE'))
  assert.ok(source.includes('takePersistableUriPermission'))
  assert.ok(source.includes('DocumentFile.fromTreeUri(activity, Uri.parse(directory))'))
  assert.ok(source.includes('tree.canWrite()'))
  assert.ok(source.includes('tree.createFile("video/mp4", fileName)'))
})

test('default directory is shared across Settings and native download helper', () => {
  const settings = readFileSync(new URL('../src/renderer/components/DownloadsSettings.vue', import.meta.url), 'utf8')
  const downloads = readFileSync(new URL('../src/renderer/helpers/android/downloads.js', import.meta.url), 'utf8')
  assert.ok(settings.includes("const DEFAULT_DIRECTORY = 'data://downloads/FreeTube'"))
  assert.ok(downloads.includes("? 'data://downloads/FreeTube'"))
  assert.ok(downloads.includes('createDownloadFile?.(downloadDirectory()'))
})

test('legacy download directories migrate to FreeTube default', () => {
  const settings = readFileSync(new URL('../src/renderer/components/DownloadsSettings.vue', import.meta.url), 'utf8')
  const downloads = readFileSync(new URL('../src/renderer/helpers/android/downloads.js', import.meta.url), 'utf8')
  for (const legacy of ['data://downloads', 'data://downloads/Freetube', 'data://downloads/FreetTube']) {
    assert.ok(settings.includes(`'${legacy}'`))
    assert.ok(downloads.includes(`'${legacy}'`))
  }
  assert.ok(settings.includes("? DEFAULT_DIRECTORY : savedDirectory"))
  assert.ok(downloads.includes("? 'data://downloads/FreeTube'"))
})

test('notification reports initial progress without byte totals', () => {
  assert.deepEqual(getDownloadNotificationPayload({ downloadId: '1', title: 'video', status: 'downloading', progress: 0 }), {
    downloadId: '1', title: 'video', text: 'Downloading 0%', progress: 0, actions: ['pause', 'cancel']
  })
})

test('completed and canceled notifications expose no recovery actions', () => {
  for (const status of ['completed', 'canceled']) {
    assert.deepEqual(getDownloadNotificationPayload({ downloadId: '1', title: 'video', status, progress: 1 }), {
      downloadId: '1', title: 'video', text: 'Downloading 100%', progress: 100, actions: []
    })
  }
})

test('notification progress is clamped to valid Android range', () => {
  assert.equal(getDownloadNotificationPayload({ downloadId: '1', title: 'video', status: 'downloading', progress: -1 }).progress, 0)
  assert.equal(getDownloadNotificationPayload({ downloadId: '1', title: 'video', status: 'downloading', progress: 2 }).progress, 100)
})

test('notification omits invalid speed and total details', () => {
  const payload = getDownloadNotificationPayload({ downloadId: '1', title: 'video', status: 'downloading', progress: 0.5, received: 20, total: 0, speedBps: 0 })
  assert.equal(payload.text, 'Downloading 50%')
})

test('paused and failed notifications expose recovery actions', () => {
  assert.deepEqual(getDownloadNotificationPayload({ downloadId: '1', title: '480p', status: 'paused', progress: 0.25 }), {
    downloadId: '1', title: '480p', text: 'Downloading 25%', progress: 25, actions: ['resume', 'cancel']
  })
  assert.deepEqual(getDownloadNotificationPayload({ downloadId: '2', title: '720p', status: 'failed', progress: 0.25 }), {
    downloadId: '2', title: '720p', text: 'Downloading 25%', progress: 25, actions: ['retry']
  })
})
