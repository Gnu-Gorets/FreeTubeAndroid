import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getDefaultQualityForNetwork } from '../src/renderer/helpers/player/network-quality.mjs'

const bridge = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')
assert.match(bridge, /val networks = connectivity\.allNetworks/)
assert.match(bridge, /if \(capabilities\.any \{ it\.hasTransport\(android\.net\.NetworkCapabilities\.TRANSPORT_WIFI\) \}\) \{\s+return "wifi"/)
assert.match(bridge, /TRANSPORT_CELLULAR\) &&\s+it\.hasCapability\(android\.net\.NetworkCapabilities\.NET_CAPABILITY_INTERNET\)/)

assert.equal(getDefaultQualityForNetwork('wifi', 1080, 480, 720), 1080)
assert.equal(getDefaultQualityForNetwork('mobile', 1080, 480, 720), 480)
assert.equal(getDefaultQualityForNetwork('unknown', 1080, 480, 720), 720)
assert.equal(getDefaultQualityForNetwork(undefined, 1080, 480, 720), 720)

console.log('network default resolution: PASS')
