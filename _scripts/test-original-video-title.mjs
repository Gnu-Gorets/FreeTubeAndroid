import assert from 'node:assert/strict'
import { getOriginalVideoTitle } from '../src/renderer/helpers/api/original-video-title.mjs'

const title = await getOriginalVideoTitle('2fE19ptXn3E', async (url) => {
  assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=2fE19ptXn3E')
  assert.equal(url.searchParams.get('format'), 'json')
  return new Response(JSON.stringify({ title: ' Русский заголовок ' }))
})

assert.equal(title, 'Русский заголовок')
console.log('original video title: PASS')
