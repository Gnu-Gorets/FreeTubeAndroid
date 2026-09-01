export function getPlaybackSource(download, getLocalPlaybackUrl) {
  if (download.offlineUri) return { offlineUri: download.offlineUri }
  if (download.localPath && typeof getLocalPlaybackUrl === 'function') {
    return { localVideoUrl: getLocalPlaybackUrl(download.localPath) }
  }
  return null
}

export function getOfflinePlaybackState(download, getLocalPlaybackUrl) {
  const source = getPlaybackSource(download, getLocalPlaybackUrl)
  return {
    videoId: download?.videoId || '',
    title: download?.title || '',
    thumbnail: download?.thumbnail || '',
    duration: download?.lengthSeconds || download?.duration || 0,
    channelId: download?.channelId || '',
    channelName: download?.channelName || '',
    channelThumbnail: download?.channelThumbnail || '',
    published: download?.published || 0,
    description: download?.description || '',
    descriptionHtml: download?.descriptionHtml || '',
    license: download?.license || '',
    viewCount: download?.viewCount ?? null,
    likeCount: download?.likeCount || 0,
    dislikeCount: download?.dislikeCount || 0,
    isLive: Boolean(download?.isLive),
    videoGenreIsMusic: Boolean(download?.videoGenreIsMusic),
    chapters: download?.chapters || [],
    captions: download?.captions || [],
    offlineUri: source?.offlineUri || null,
    localVideoUrl: source?.localVideoUrl || null,
    manifestMimeType: source?.offlineUri ? 'application/x-offline-manifest' : ''
  }
}
