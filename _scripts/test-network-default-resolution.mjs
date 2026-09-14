import assert from 'node:assert/strict'
import { getDefaultQualityForNetwork } from '../src/renderer/helpers/player/network-quality.mjs'

assert.equal(getDefaultQualityForNetwork('wifi', 1080, 480, 720), 1080)
assert.equal(getDefaultQualityForNetwork('mobile', 1080, 480, 720), 480)
assert.equal(getDefaultQualityForNetwork('unknown', 1080, 480, 720), 720)
assert.equal(getDefaultQualityForNetwork(undefined, 1080, 480, 720), 720)

console.log('network default resolution: PASS')
