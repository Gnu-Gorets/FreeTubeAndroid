/**
 * Resolve one local playback source.
 * `offlineUri` is a Shaka offline manifest; `localPath` is an Android file URI
 * that must be converted to a WebView URL by native bridge.
 */
export function getPlaybackSource(download, getLocalPlaybackUrl) {
  if (download.offlineUri) return { offlineUri: download.offlineUri }
  if (download.localPath && typeof getLocalPlaybackUrl === 'function') {
    return { localVideoUrl: getLocalPlaybackUrl(download.localPath) }
  }
  return null
}

export function createDownloadedPlaylistRoute(downloadIds) {
  const ids = Array.isArray(downloadIds) ? downloadIds.filter(Boolean) : []
  return {
    query: {
      offline: ids[0] || '',
      offlinePlaylist: ids.join(',')
    }
  }
}

export function getCompletedDownloadRecords(downloads) {
  return Array.isArray(downloads) ? downloads.filter(download => download?.status === 'completed') : []
}

export function getPlayableDownloadRecords(downloads, getLocalPlaybackUrl) {
  return getCompletedDownloadRecords(downloads)
    .filter(download => getPlaybackSource(download, getLocalPlaybackUrl))
}

export function getDownloadedSources(downloads, videoId, getLocalPlaybackUrl) {
  if (!Array.isArray(downloads)) return []
  return downloads
    .filter(download => download && download.videoId === videoId && download.status === 'completed')
    .map(download => ({
      downloadId: download.downloadId,
      selectedFormat: download.selectedFormat || '',
      source: getPlaybackSource(download, getLocalPlaybackUrl)
    }))
    .filter(download => download.source && (download.source.offlineUri || download.source.localVideoUrl))
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
