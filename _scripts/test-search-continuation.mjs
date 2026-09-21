import assert from 'node:assert/strict'
import { Mixins, Parser } from 'youtubei.js'

import { createLocalSearchContinuation } from '../src/renderer/helpers/api/local-search-continuation.mjs'

const page = Parser.parseResponse({
  onResponseReceivedCommands: [{
    appendContinuationItemsAction: {
      continuationItems: [
        {
          itemSectionRenderer: {
            contents: [{
              videoRenderer: {
                videoId: 'video-id',
                title: { simpleText: 'Video' }
              }
            }]
          }
        },
        {
          continuationItemRenderer: {
            continuationEndpoint: {
              continuationCommand: { token: 'next-page-token' }
            }
          }
        }
      ]
    }
  }]
})

const continuation = createLocalSearchContinuation({}, page)

assert.ok(continuation instanceof Mixins.Feed)
assert.equal(continuation.results.length, 1)
assert.equal(continuation.results[0].video_id, 'video-id')
assert.equal(continuation.has_continuation, true)

console.log('search continuation append action: PASS')
