import assert from 'node:assert/strict'
import { getUniqueLegacyFormats } from '../src/renderer/components/FtShakaVideoPlayer/player-components/legacy-quality.mjs'

const formats = [
  { qualityLabel: '720p', width: 1280, height: 720, bitrate: 900_000 },
  { qualityLabel: '144p', width: 256, height: 144, bitrate: 80_000 },
  { qualityLabel: '144p', width: 256, height: 144, bitrate: 120_000 },
  { qualityLabel: '480p', width: 854, height: 480, bitrate: 500_000 }
]

assert.deepEqual(
  getUniqueLegacyFormats(formats).map(format => format.qualityLabel),
  ['720p', '480p', '144p']
)
assert.equal(getUniqueLegacyFormats(formats)[2].bitrate, 120_000)
assert.equal(getUniqueLegacyFormats([]).length, 0)

console.log('Legacy quality selection tests passed')
