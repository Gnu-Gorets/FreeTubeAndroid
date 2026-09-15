export async function getOriginalVideoTitle (videoId, fetch_ = fetch) {
  const url = new URL('https://www.youtube.com/oembed')
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`)
  url.searchParams.set('format', 'json')

  const response = await fetch_(url)
  if (!response.ok) {
    throw new Error(`YouTube oEmbed request failed: ${response.status}`)
  }

  const { title } = await response.json()
  return typeof title === 'string' ? title.trim() : ''
}
