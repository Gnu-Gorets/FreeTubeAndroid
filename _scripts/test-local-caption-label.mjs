import assert from 'node:assert/strict'

import { getLocalCaptionLabel } from '../src/renderer/helpers/player/local-caption-label.mjs'

assert.equal(getLocalCaptionLabel({ name: { text: 'English (auto-generated)' }, language_code: 'en' }), 'English (auto-generated)')
assert.equal(getLocalCaptionLabel({ name: { text: '' }, language_code: 'en' }), '')
assert.equal(getLocalCaptionLabel({ language_code: 'fr' }), 'fr')

console.log('local caption label: PASS')
