export async function fetchLocalApi (input, init) {
  if (!process.env.IS_ELECTRON) return fetch(input, init)

  const request = new Request(input, init)
  if (new URL(request.url).origin !== 'https://www.youtube.com') return fetch(input, init)

  const response = await window.ftElectron.fetchLocalApi({
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    credentials: request.credentials,
    body: request.body ? await request.clone().arrayBuffer() : undefined
  })
  const body = [204, 205, 304].includes(response.status) || !response.body.byteLength ? null : response.body

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
