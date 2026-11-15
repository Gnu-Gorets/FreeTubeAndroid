import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parsePlaylistImportData } from '../src/renderer/helpers/playlistImport.mjs'

const dataSettings = await readFile(new URL('../src/renderer/components/DataSettings/DataSettings.vue', import.meta.url), 'utf8')
const playlistImporter = dataSettings.match(/async function importPlaylists\(\) \{([\s\S]*?)\n\}\n\nasync function exportPlaylists/)?.[1]

test('playlist import parses legacy JSON arrays', () => {
  assert.deepEqual(parsePlaylistImportData('[{"playlistName":"Saved","videos":[]}]'), [
    { playlistName: 'Saved', videos: [] }
  ])
})

test('playlist import parses line-delimited exports with or without a trailing newline', () => {
  const first = JSON.stringify({ playlistName: 'One', videos: [] })
  const second = JSON.stringify({ playlistName: 'Two', videos: [] })

  assert.deepEqual(parsePlaylistImportData(`${first}\n${second}\n`), [
    { playlistName: 'One', videos: [] },
    { playlistName: 'Two', videos: [] }
  ])
  assert.deepEqual(parsePlaylistImportData(`${first}\n${second}`), [
    { playlistName: 'One', videos: [] },
    { playlistName: 'Two', videos: [] }
  ])
})

test('playlist import rejects malformed exports', () => {
  assert.throws(() => parsePlaylistImportData('{invalid json'), SyntaxError)
})

test('playlist importer validates playlist and video data and reports successful imports', () => {
  assert.ok(playlistImporter)
  assert.match(playlistImporter, /playlistData === null \|\| typeof playlistData !== 'object' \|\| Array\.isArray\(playlistData\)/)
  assert.match(playlistImporter, /!Array\.isArray\(playlistData\.videos\)/)
  assert.match(playlistImporter, /video !== null && typeof video === 'object'/)
  assert.match(playlistImporter, /allVideosSkipped = playlistData\.videos\?\.length > 0/)
  assert.match(playlistImporter, /importedPlaylistCount\+\+/)
  assert.match(playlistImporter, /count: importedPlaylistCount, total: playlists\.length/)
})
