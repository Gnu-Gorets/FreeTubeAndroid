import assert from 'node:assert/strict'
import test from 'node:test'

import { getChannelsHiddenIdSet } from '../src/renderer/helpers/channelsHidden.mjs'

test('hidden-channel IDs support legacy strings and current objects', () => {
  const ids = getChannelsHiddenIdSet(JSON.stringify([
    'legacy-channel',
    { name: 'UC-channel', preferredName: 'Channel' },
    null,
    { preferredName: 'Missing ID' }
  ]))

  assert.deepEqual([...ids], ['legacy-channel', 'UC-channel'])
  assert.equal(ids.has('legacy-channel'), true)
  assert.equal(ids.has('UC-channel'), true)
  assert.equal(ids.has('Channel'), false)
})
