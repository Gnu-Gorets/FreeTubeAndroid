import assert from 'node:assert/strict'
import test from 'node:test'
import { getCaptionLanguageName, getCaptionTrackLanguage } from '../src/renderer/helpers/player/captions.mjs'

test('caption track with missing name falls back to language code', () => {
  assert.equal(getCaptionTrackLanguage({ name: null, language_code: 'en' }), 'en')
})

test('caption track keeps localized name when available', () => {
  assert.equal(getCaptionTrackLanguage({ name: { text: 'English' }, language_code: 'en' }), 'English')
})

test('translation language with missing name falls back to language code', () => {
  assert.equal(getCaptionLanguageName({ language_name: null, language_code: 'en' }), 'en')
})
