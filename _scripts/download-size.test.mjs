import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDownloadSpeed, normalizeDownloadSize } from '../src/renderer/helpers/download-size.mjs'

test('accepts byte sizes from stream metadata', () => {
  assert.equal(normalizeDownloadSize(123456789), 123456789)
  assert.equal(normalizeDownloadSize('123456789'), 123456789)
})

test('rejects dimensions and unknown sizes', () => {
  assert.equal(normalizeDownloadSize('1920x1080'), -1)
  assert.equal(normalizeDownloadSize(''), -1)
  assert.equal(normalizeDownloadSize(undefined), -1)
  assert.equal(normalizeDownloadSize(-1), -1)
})

test('formats speed as MiB instead of KiB', () => {
  assert.equal(formatDownloadSpeed(512 * 1024), '0.5 MiB')
  assert.equal(formatDownloadSpeed(12 * 1024 ** 2), '12 MiB')
})
