import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { getDownloadNotificationId, getDownloadNotificationPayload } from '../src/renderer/helpers/android/download-notification.mjs'

test('notification IDs are stable and distinct', () => {
  assert.equal(getDownloadNotificationId('download-1'), getDownloadNotificationId('download-1'))
  assert.notEqual(getDownloadNotificationId('download-1'), getDownloadNotificationId('download-2'))
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
})

test('paused and failed notifications expose recovery actions', () => {
  assert.deepEqual(getDownloadNotificationPayload({ downloadId: '1', title: '480p', status: 'paused', progress: 0.25 }), {
    downloadId: '1', title: '480p', text: 'Downloading 25%', progress: 25, actions: ['resume', 'cancel']
  })
  assert.deepEqual(getDownloadNotificationPayload({ downloadId: '2', title: '720p', status: 'failed', progress: 0.25 }), {
    downloadId: '2', title: '720p', text: 'Downloading 25%', progress: 25, actions: ['retry']
  })
})
