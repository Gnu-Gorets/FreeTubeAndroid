import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getDefaultQualityForNetwork } from '../src/renderer/helpers/player/network-quality.mjs'

const bridge = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')
assert.match(bridge, /val network = connectivity\.activeNetwork \?: return "unknown"/)
assert.match(bridge, /val capabilities = connectivity\.getNetworkCapabilities\(network\) \?: return "unknown"/)
assert.match(bridge, /capabilities\.hasTransport\(android\.net\.NetworkCapabilities\.TRANSPORT_WIFI\)/)
assert.match(bridge, /capabilities\.hasTransport\(android\.net\.NetworkCapabilities\.TRANSPORT_CELLULAR\)/)

assert.equal(getDefaultQualityForNetwork('wifi', 1080, 480, 720), 1080)
assert.equal(getDefaultQualityForNetwork('mobile', 1080, 480, 720), 480)
assert.equal(getDefaultQualityForNetwork('unknown', 1080, 480, 720), 720)
assert.equal(getDefaultQualityForNetwork(undefined, 1080, 480, 720), 720)

console.log('network default resolution: PASS')
