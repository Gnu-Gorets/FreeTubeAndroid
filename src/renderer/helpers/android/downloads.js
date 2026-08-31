import android from 'android'
import shaka from 'shaka-player'
import { requestSaveDialog } from './dialogs'
import { setupSabrScheme } from '../player/SabrSchemePlugin'

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

const sabrOperations = new Map()

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

export async function storeSabrDownload(download, onProgress) {
  if (!download.manifestSrc || !download.sabrData || !shaka.offline?.Storage) throw new Error('SABR download is unavailable')
  const video = document.createElement('video')
  const player = new shaka.Player(video)
  const manifestRef = { value: null }
  let storage = null
  setupSabrScheme(download.sabrData, () => player, () => manifestRef.value, 640, 360)
  try {
    await player.load(download.manifestSrc, null, download.manifestMimeType)
    manifestRef.value = player.getManifest()
    storage = new shaka.offline.Storage(player)
    storage.configure({
      offline: {
        progressCallback(content, progress) {
          onProgress?.(content, progress)
          android.updateDownloadNotification?.(download.title || 'Download', Math.round(progress * 100))
        }
      }
    })
    const operation = storage.store(download.manifestSrc, {}, download.manifestMimeType)
    sabrOperations.set(download.downloadId, operation)
    const content = await operation.promise
    if (!content?.offlineUri) {
      console.error(`[SABR] storage returned invalid content: ${JSON.stringify(content)}`)
      throw new Error('Offline storage returned no URI')
    }
    return content
  } finally {
    sabrOperations.delete(download.downloadId)
    await storage?.destroy()
    await player.destroy()
  }
}

export async function recoverSabrDownload(download, onProgress) {
  const content = await storeSabrDownload(download, onProgress)
  return content.offlineUri
}

export function hasSabrDownload(downloadId) {
  return sabrOperations.has(downloadId)
}

export function cancelSabrDownload(downloadId) {
  sabrOperations.get(downloadId)?.abort()
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
    downloadId,
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
  if (typeof android.enqueueNativeDownload === 'function') {
    const queued = android.enqueueNativeDownload(JSON.stringify({
      id: downloadId,
      title: video.title,
      videoUrl: video.videoUrl,
      audioUrl: video.audioUrl || '',
      targetUri: dialog.uri,
      finalName: fileName
    }))
    if (!queued) throw new Error('Unable to queue download')
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          const item = JSON.parse(android.getNativeDownloadQueue?.() || '[]').find(entry => entry.id === downloadId)
          if (!item) return
          Object.assign(metadata, { status: item.status, progress: item.progress, error: item.error || null })
          if (item.status === 'completed') {
            metadata.fileName = fileName
            metadata.completedAt = Date.now()
          }
          localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
          if (['completed', 'failed', 'canceled'].includes(item.status)) {
            clearInterval(timer)
            item.status === 'completed' ? resolve() : reject(new Error(item.error || 'Download failed'))
          }
        } catch (error) {
          clearInterval(timer)
          reject(error)
        }
      }, 500)
    })
  }
  const result = new Promise((resolve, reject) => {
    const onEvent = (event) => {
      if (event.detail?.id !== downloadId) return
      if (event.detail.status === 'progress') {
        metadata.progress = event.detail.total > 0 ? event.detail.received / event.detail.total : null
        android.updateDownloadNotification?.(video.title, Math.round((metadata.progress ?? 0) * 100))
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
        android.finishDownloadNotification?.(video.title, true)
        metadata.fileName = fileName
        metadata.completedAt = Date.now()
        localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
        resolve()
      } else if (event.detail.status === 'failed' || event.detail.status === 'canceled') {
        window.removeEventListener(eventName, onEvent)
        android.deleteFile(dialog.uri)
        metadata.status = event.detail.status
        android.finishDownloadNotification?.(video.title, false)
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
