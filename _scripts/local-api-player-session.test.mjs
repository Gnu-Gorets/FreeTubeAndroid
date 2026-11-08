import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const localApi = await readFile(new URL('../src/renderer/helpers/api/local.js', import.meta.url), 'utf8')

test('Local API shares decipher player with VideoInfo actions session', () => {
  const playerCreation = localApi.indexOf('const player = await Player.create(')
  const sessionAssignment = localApi.indexOf('htmlExtracts.session.player = player')
  const videoInfoConstruction = localApi.indexOf('new YT.VideoInfo(')

  assert.notEqual(playerCreation, -1)
  assert.ok(sessionAssignment > playerCreation)
  assert.ok(videoInfoConstruction > sessionAssignment)
})
