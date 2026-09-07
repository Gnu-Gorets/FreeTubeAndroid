import assert from 'node:assert/strict'
import test from 'node:test'
import { compareAudioFormats, compareAudioSizes, getAudioFormatsForTrack } from '../src/renderer/helpers/download-selection.mjs'

const formats = [
  { id: 'webm-best', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/webm', bitrate: 192000, size: 9_000_000 },
  { id: 'm4a-low', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/mp4', bitrate: 128000, size: 6_000_000 },
  { id: 'm4a-best', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/mp4', bitrate: 192000, size: 9_000_000 },
  { id: 'webm-small', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/webm', bitrate: 256000, size: 5_000_000 },
  { id: 'en-best', kind: 'audio', audioTrackId: 'en-US.10', mimeType: 'audio/mp4', bitrate: 256000, size: 12_000_000 }
]

test('video selects compatible highest bitrate audio', () => {
  assert.deepEqual(
    getAudioFormatsForTrack(formats, 'ru.4', 'video/mp4').map(format => format.id),
    ['m4a-best', 'm4a-low']
  )
})

test('audio mode sorts all containers by size', () => {
  assert.deepEqual(
    getAudioFormatsForTrack(formats, 'ru.4', '', 'size').map(format => format.id),
    ['webm-best', 'm4a-best', 'm4a-low', 'webm-small']
  )
})

test('equal bitrate prefers larger stream', () => {
  assert.equal(compareAudioFormats(
    { bitrate: 192000, size: 6_000_000 },
    { bitrate: 192000, size: 9_000_000 }
  ), 3_000_000)
})

test('audio size sort uses bitrate as tie breaker', () => {
  assert.equal(compareAudioSizes(
    { bitrate: 128000, size: 9_000_000 },
    { bitrate: 192000, size: 9_000_000 }
  ), 64_000)
})
