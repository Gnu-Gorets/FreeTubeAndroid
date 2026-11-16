import assert from 'node:assert/strict'
import { fetchLocalApiRequest } from '../src/main/localApiFetch.mjs'

function request (overrides = {}) {
  return {
    url: 'https://www.youtube.com/youtubei/v1/player',
    method: 'POST',
    headers: [['content-type', 'application/json'], ['x-youtube-client-version', '1.0']],
    credentials: 'include',
    body: new TextEncoder().encode('{}'),
    ...overrides
  }
}

const allowedResponse = await fetchLocalApiRequest(request(), async (url, init) => {
  assert.equal(url, 'https://www.youtube.com/youtubei/v1/player')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'include')
  return new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'private=value' }
  })
})
assert.equal(allowedResponse.status, 200)
assert.deepEqual(allowedResponse.headers, [['content-type', 'application/json']])
assert.equal(new TextDecoder().decode(allowedResponse.body), '{"ok":true}')

for (const sessionRequest of [
  request({
    url: 'https://www.youtube.com/sw.js_data',
    method: 'GET',
    headers: [['accept', '*/*'], ['cookie', 'PREF=tz=UTC']],
    body: undefined
  }),
  request({
    url: 'https://www.youtube.com/youtubei/v1/config?prettyPrint=false',
    headers: [['X-Origin', 'https://www.youtube.com'], ['content-type', 'application/json']]
  })
]) {
  const response = await fetchLocalApiRequest(sessionRequest, async (url, init) => {
    assert.equal(url, sessionRequest.url)
    assert.equal(init.method, sessionRequest.method)
    for (const [name, value] of sessionRequest.headers) {
      assert.equal(init.headers.get(name), value)
    }
    return new Response('{"session":true}')
  })
  assert.equal(new TextDecoder().decode(response.body), '{"session":true}')
}

for (const method of ['GET', 'HEAD']) {
  const response = await fetchLocalApiRequest({
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=test',
    method,
    headers: [],
    credentials: 'same-origin'
  }, async (url, init) => {
    assert.equal(new URL(url).pathname, '/feeds/videos.xml')
    assert.equal(init.method, method)
    return new Response(method === 'GET' ? '<feed />' : null)
  })
  assert.equal(new TextDecoder().decode(response.body), method === 'GET' ? '<feed />' : '')
}

for (const invalid of [
  request({ url: 'https://example.com/youtubei/v1/player' }),
  request({ url: 'http://www.youtube.com/youtubei/v1/player' }),
  request({ url: 'https://www.youtube.com/private' }),
  request({ url: 'https://www.youtube.com/sw.js_data' }),
  request({ url: 'https://www.youtube.com/sw.js_data/extra', method: 'GET', body: undefined }),
  request({ url: 'https://www.youtube.com/watch', method: 'POST' }),
  request({ url: 'https://www.youtube.com/feeds/videos.xml', method: 'POST' }),
  request({ headers: [['x-arbitrary-header', 'value']] }),
  request({ body: new Uint8Array(2 * 1024 * 1024 + 1) })
]) {
  await assert.rejects(fetchLocalApiRequest(invalid, async () => new Response('unexpected')), TypeError)
}

let requestCount = 0
const redirectedResponse = await fetchLocalApiRequest(request({
  url: 'https://www.youtube.com/',
  method: 'GET',
  headers: [],
  body: undefined,
  credentials: 'same-origin'
}), async (url) => {
  requestCount++
  if (requestCount === 1) {
    assert.equal(url, 'https://www.youtube.com/')
    return new Response(null, { status: 302, headers: { location: '/watch?v=test' } })
  }
  assert.equal(url, 'https://www.youtube.com/watch?v=test')
  return new Response('watch page')
})
assert.equal(requestCount, 2)
assert.equal(new TextDecoder().decode(redirectedResponse.body), 'watch page')

let headRedirectCount = 0
await fetchLocalApiRequest({
  url: 'https://www.youtube.com/feeds/videos.xml',
  method: 'HEAD',
  headers: [],
  credentials: 'same-origin'
}, async (_, init) => {
  headRedirectCount++
  if (headRedirectCount === 1) return new Response(null, { status: 303, headers: { location: '/feeds/videos.xml' } })
  assert.equal(init.method, 'HEAD')
  return new Response(null)
})
assert.equal(headRedirectCount, 2)

await assert.rejects(fetchLocalApiRequest(request({
  url: 'https://www.youtube.com/',
  method: 'GET',
  headers: [],
  body: undefined,
  credentials: 'same-origin'
}), async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })), /URL is not allowed/)

const previousElectronEnv = process.env.IS_ELECTRON
process.env.IS_ELECTRON = 'true'
let bridgedRequest
const previousWindow = globalThis.window
globalThis.window = {
  ftElectron: {
    fetchLocalApi: async request => {
      bridgedRequest = request
      return {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']],
        body: new TextEncoder().encode('{"ok":true}')
      }
    }
  }
}
const { fetchLocalApi } = await import('../src/renderer/helpers/api/local-fetch.mjs')
const rendererResponse = await fetchLocalApi(new Request('https://www.youtube.com/youtubei/v1/player', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: '{}'
}))
assert.equal(bridgedRequest.url, 'https://www.youtube.com/youtubei/v1/player')
assert.equal(bridgedRequest.method, 'POST')
assert.equal(bridgedRequest.credentials, 'include')
assert.equal(new TextDecoder().decode(bridgedRequest.body), '{}')
assert.equal(await rendererResponse.text(), '{"ok":true}')
if (previousElectronEnv === undefined) delete process.env.IS_ELECTRON
else process.env.IS_ELECTRON = previousElectronEnv
if (previousWindow === undefined) delete globalThis.window
else globalThis.window = previousWindow

console.log('Local API fetch bridge checks passed')
