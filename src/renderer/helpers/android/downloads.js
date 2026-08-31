import android from 'android'
import { requestSaveDialog } from './dialogs'

function bestFormat(formats, predicate) {
  return formats
    .filter(format => format.url && predicate(format))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null
}

export function selectDownloadFormats(progressiveFormats, adaptiveFormats = []) {
  const progressive = bestFormat(progressiveFormats, format => !format.mimeType || format.mimeType.startsWith('video/'))
  if (progressive) return { video: progressive, audio: null }

  const video = bestFormat(adaptiveFormats, format => format.mimeType?.startsWith('video/mp4'))
  const audio = bestFormat(adaptiveFormats, format => format.mimeType?.startsWith('audio/mp4'))
  return video && audio ? { video, audio } : null
}

function readDownloadMetadata() {
  try {
    return JSON.parse(localStorage.getItem('freetube-downloads') || '[]')
  } catch {
    return []
  }
}

export function recordDownloadMetadata(metadata) {
  const downloads = readDownloadMetadata()
  downloads.push(metadata)
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
  return downloads
}

export function updateDownloadMetadata(downloadId, changes) {
  const downloads = readDownloadMetadata()
  const download = downloads.find(item => item.downloadId === downloadId)
  if (!download) return
  Object.assign(download, changes)
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
}

function safeFileName(title, id) {
  const name = title.replaceAll(/[\\/:*?"<>|]/g, '_').replaceAll(/\s+/g, ' ').trim()
  return `${(name || id).slice(0, 180)}.mp4`
}

/**
 * Downloads one video through Android native storage.
 * @param {{id: string, title: string, videoUrl: string, audioUrl?: string|null, thumbnail?: string, sourceBackend?: string}} video
 * @returns {Promise<void>}
 */
export async function downloadProgressiveVideo(video) {
  if (!process.env.IS_ANDROID || typeof android.downloadUrl !== 'function' ||
    (video.audioUrl && typeof android.muxDownload !== 'function')) {
    throw new Error('Downloads are only available on Android with native MP4 muxing')
  }

  const fileName = safeFileName(video.title, video.id)
  const dialog = await requestSaveDialog(`${fileName}.part`, 'video/mp4')
  if (dialog.canceled) return

  const downloadId = globalThis.crypto?.randomUUID?.() ?? `download-${Date.now()}`
  const eventName = 'android-download'
  const metadata = {
    videoId: video.id,
    title: video.title,
    thumbnail: video.thumbnail ?? '',
    sourceBackend: video.sourceBackend ?? 'unknown',
    selectedFormat: video.audioUrl ? 'adaptive-mp4' : 'progressive',
    localPath: dialog.uri,
    status: 'downloading',
    createdAt: Date.now()
  }
  const downloads = recordDownloadMetadata(metadata)
  const result = new Promise((resolve, reject) => {
    const onEvent = (event) => {
      if (event.detail?.id !== downloadId) return
      if (event.detail.status === 'progress') {
        metadata.progress = event.detail.total > 0 ? event.detail.received / event.detail.total : null
        localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
        return
      }
      if (event.detail.status === 'completed') {
        window.removeEventListener(eventName, onEvent)
        if (!android.renameFile(dialog.uri, fileName)) {
          android.deleteFile(dialog.uri)
          reject(new Error('Unable to finalize downloaded file'))
          return
        }
        metadata.status = 'completed'
        metadata.fileName = fileName
        metadata.completedAt = Date.now()
        localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
        resolve()
      } else if (event.detail.status === 'failed' || event.detail.status === 'canceled') {
        window.removeEventListener(eventName, onEvent)
        android.deleteFile(dialog.uri)
        metadata.status = event.detail.status
        metadata.error = event.detail.error || null
        localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
        reject(new Error(event.detail.error || 'Download failed'))
      }
    }
    window.addEventListener(eventName, onEvent)
  })

  const startDownload = video.audioUrl && typeof android.muxDownload === 'function'
    ? android.muxDownload(video.videoUrl, video.audioUrl, dialog.uri, downloadId)
    : android.downloadUrl(video.videoUrl, dialog.uri, downloadId)
  if (!startDownload) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { id: downloadId, status: 'failed', error: 'Unable to start download' } }))
  }

  return result
}
