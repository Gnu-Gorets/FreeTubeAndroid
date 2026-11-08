import assert from 'node:assert/strict'
import test from 'node:test'
import { getDownloadQualityLabel } from '../src/renderer/helpers/download-quality.mjs'

test('keeps online resolution label unchanged across API field names', () => {
  assert.equal(getDownloadQualityLabel({ quality_label: '720p60', quality: 'hd720' }), '720p60')
  assert.equal(getDownloadQualityLabel({ qualityLabel: '1080p60' }), '1080p60')
  assert.equal(getDownloadQualityLabel({ quality: 'hd720' }), '')
  assert.equal(getDownloadQualityLabel({}), '')
})
