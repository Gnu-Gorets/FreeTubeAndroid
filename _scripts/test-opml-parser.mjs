import assert from 'node:assert/strict'
import { parseOpmlFeeds } from '../src/renderer/helpers/parseOpmlFeeds.mjs'

assert.deepEqual(parseOpmlFeeds(`
  <opml><body><outline text="group">
    <outline xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC1" title="A &amp; B" />
  </outline></body></opml>
`), [{ xmlUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1', title: 'A & B' }])
assert.throws(() => parseOpmlFeeds('<opml><body><outline'))
assert.deepEqual(parseOpmlFeeds('<opml><body><outline title="outside" xmlUrl="https://x" /></body></opml>'), [
  { title: 'outside', xmlUrl: 'https://x' }
])

console.log('OPML parser test: PASS')
