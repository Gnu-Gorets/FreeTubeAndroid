export function getDownloadNotificationId(downloadId) {
  let hash = 0
  for (const character of downloadId) hash = (hash * 31 + character.codePointAt(0)) | 0
  return 3000 + ((hash >>> 0) % 100000)
}

export function getDownloadNotificationPayload({ downloadId, title, status, progress, received = 0, total = 0, speedBps = 0 }) {
  const actions = status === 'downloading'
    ? ['pause', 'cancel']
    : status === 'paused'
      ? ['resume', 'cancel']
      : status === 'failed' ? ['retry'] : []
  const size = total > 0 ? ` · ${received} / ${total}` : ''
  const speed = speedBps > 0 ? ` · ${speedBps}/s` : ''
  return {
    downloadId,
    title,
    text: `Downloading ${Math.round(progress * 100)}%${size}${speed}`,
    progress: Math.max(0, Math.min(100, Math.round(progress * 100))),
    actions
  }
}
