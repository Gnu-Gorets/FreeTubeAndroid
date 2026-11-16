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

for (const title of ['A &amp; B', 'A & B']) {
  assert.deepEqual(parseOpmlFeeds(`
    <opml><head><outline xmlUrl="https://outside.example" /></head><body>
      <outline text="group"><outline title="${title}" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC1" /></outline>
      <outline title="Second" xmlUrl="https://invidious.example/feed/channel/UC2" />
    </body></opml>
  `), [
    { title: 'A & B', xmlUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1' },
    { title: 'Second', xmlUrl: 'https://invidious.example/feed/channel/UC2' }
  ])
}
assert.throws(() => parseOpmlFeeds('<opml><body><outline title="A & B" xmlUrl="https://x"'))

console.log('OPML parser test: PASS')
