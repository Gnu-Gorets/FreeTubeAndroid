const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 30000

const ALLOWED_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'x-cookie',
  'x-goog-api-format-version',
  'x-goog-authuser',
  'x-goog-pageid',
  'x-goog-visitor-id',
  'x-youtube-bootstrap-logged-in',
  'x-youtube-client-name',
  'x-youtube-client-version',
  'x-youtube-page-cl',
  'x-youtube-page-label',
  'x-youtube-time-zone',
  'x-youtube-utc-offset'
])

const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'retry-after',
  'x-youtube-page-cl',
  'x-youtube-page-label'
])

function isAllowedPath (pathname, method) {
  if (method === 'GET' && ['/', '/watch', '/iframe_api'].includes(pathname)) {
    return true
  }

  if (pathname === '/feeds/videos.xml') {
    return method === 'GET' || method === 'HEAD'
  }

  if (pathname.startsWith('/youtubei/')) {
    return method === 'GET' || method === 'POST'
  }

  return method === 'GET' && /^\/s\/player\/[\w.-]+\/player_[\w.-]+\.vflset\/[\w-]+\/base\.js$/.test(pathname)
}

function normalizeRequest (request) {
  if (!request || typeof request !== 'object' || typeof request.url !== 'string' || request.url.length > 4096) {
    throw new TypeError('Invalid Local API request')
  }

  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.origin !== 'https://www.youtube.com' || url.username || url.password || url.hash) {
    throw new TypeError('Local API request URL is not allowed')
  }

  const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET'
  if (!isAllowedPath(url.pathname, method)) {
    throw new TypeError('Local API request path or method is not allowed')
  }

  if (!Array.isArray(request.headers) || request.headers.length > 32) {
    throw new TypeError('Invalid Local API request headers')
  }

  const headers = new Headers()
  let headerBytes = 0
  for (const entry of request.headers) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw new TypeError('Invalid Local API request header')
    }

    const [name, value] = entry
    const normalizedName = name.toLowerCase()
    headerBytes += name.length + value.length
    if (!ALLOWED_HEADERS.has(normalizedName) || /[\r\n]/.test(value) || headerBytes > 16 * 1024) {
      throw new TypeError('Local API request header is not allowed')
    }
    headers.append(normalizedName, value)
  }

  if (!['include', 'omit', 'same-origin'].includes(request.credentials)) {
    throw new TypeError('Invalid Local API credentials mode')
  }

  let body
  if (request.body !== undefined && request.body !== null) {
    if (method !== 'POST' || !(request.body instanceof ArrayBuffer || ArrayBuffer.isView(request.body))) {
      throw new TypeError('Invalid Local API request body')
    }
    body = request.body instanceof ArrayBuffer
      ? new Uint8Array(request.body)
      : new Uint8Array(request.body.buffer, request.body.byteOffset, request.body.byteLength)
    if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new TypeError('Local API request body is too large')
    }
  }

  return { url, method, headers, body, credentials: request.credentials }
}

async function readResponseBody (response) {
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel()
        throw new TypeError('Local API response body is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** @param {(url: string, init: RequestInit) => Promise<Response>} fetchRequest */
export async function fetchLocalApiRequest (request, fetchRequest) {
  let current = normalizeRequest(request)

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetchRequest(current.url.toString(), {
      method: current.method,
      headers: current.headers,
      body: current.body,
      credentials: current.credentials,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    const location = response.headers.get('location')
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (redirectCount === MAX_REDIRECTS) {
        throw new TypeError('Local API request exceeded redirect limit')
      }

      const nextUrl = new URL(location, current.url)
      const nextMethod = (response.status === 303 && current.method !== 'HEAD') || ((response.status === 301 || response.status === 302) && current.method === 'POST')
        ? 'GET'
        : current.method
      const normalized = normalizeRequest({
        ...request,
        url: nextUrl.toString(),
        method: nextMethod,
        body: nextMethod === 'GET' ? undefined : current.body,
        headers: [...current.headers].filter(([name]) => nextMethod !== 'GET' || !['content-type'].includes(name)),
        credentials: current.credentials
      })
      current = normalized
      continue
    }

    const body = await readResponseBody(response)
    const headers = [...response.headers]
      .filter(([name]) => ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase()))

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body
    }
  }

  throw new TypeError('Local API request failed')
}
