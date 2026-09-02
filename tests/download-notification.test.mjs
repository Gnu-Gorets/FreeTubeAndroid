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
  assert.ok(source.includes('notificationManager.cancel(notificationId)'))
})

test('Android default downloads use public Freetube folder', () => {
  const source = readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
  assert.match(source, /RELATIVE_PATH, "\$\{Environment\.DIRECTORY_DOWNLOADS\}\/FreeTube"/)
  assert.match(source, /IS_PENDING, 1/)
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
