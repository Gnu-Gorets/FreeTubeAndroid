import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const bridge = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')

// External players need upstream total size in Content-Range. Using
// rangeStart + partialLength advertises current chunk size as full file size.
assert.match(
  bridge,
  /val upstreamContentRange = connection\.getHeaderField\("Content-Range"\)/,
  'relay must read upstream Content-Range'
)
assert.match(
  bridge,
  /upstreamContentRange\?\.let/,
  'relay must forward upstream Content-Range'
)
assert.doesNotMatch(
  bridge,
  /Content-Range: bytes \$rangeStart-\$\{totalLength!! - 1\}\/\$totalLength/,
  'relay must not derive total media size from partial response length'
)

console.log('external player range regression guard: PASS')
