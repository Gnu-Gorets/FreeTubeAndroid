export function filterDownloads(downloads, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase()
  if (!normalizedQuery) return downloads
  return downloads.filter(download => [download.title, download.selectedFormat, download.status, download.localPath, download.videoId]
    .some(value => String(value || '').toLocaleLowerCase().includes(normalizedQuery)))
}
