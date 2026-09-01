import android from 'android'
import shaka from 'shaka-player'
import { requestSaveDialog } from './dialogs'
import { setupSabrScheme } from '../player/SabrSchemePlugin'
import { getDownloadNotificationPayload } from './download-notification.mjs'

const log = (...args) => console.warn('[Downloads]', ...args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg))

const QUALITY_HEIGHTS = { large: 480, medium: 360, small: 240, tiny: 144 }

function qualityHeight(format) {
  const match = format.quality?.match(/(?:hd)?(\d+)/)
  return match ? Number(match[1]) : QUALITY_HEIGHTS[format.quality] ?? format.height
}

function bestFormat(formats, predicate) {
  return formats
    .filter(format => format.url && predicate(format))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null
}

export function getDownloadFormats(progressiveFormats = [], adaptiveFormats = []) {
  log('quality candidates', { progressive: progressiveFormats.length, adaptive: adaptiveFormats.length })
  const progressive = progressiveFormats
    .filter(format => format.url && (!format.mimeType || format.mimeType.startsWith('video/')))
    .map(format => ({ video: format, audio: null, label: `${format.height ?? '?'}p` }))
  const audio = bestFormat(adaptiveFormats, format => format.mimeType?.startsWith('audio/mp4'))
  const adaptive = audio
    ? adaptiveFormats
        .filter(format => format.url && format.mimeType?.startsWith('video/mp4'))
        .map(format => ({ video: format, audio, label: `${format.height ?? '?'}p (adaptive)` }))
    : []
  return [...progressive, ...adaptive]
    .sort((a, b) => (b.video.height ?? 0) - (a.video.height ?? 0) || (b.video.bitrate ?? 0) - (a.video.bitrate ?? 0))
}

export function getSabrDownloadFormats(manifestSrc) {
  try {
    const prefix = 'data:application/sabr+json,'
    if (!manifestSrc?.startsWith(prefix)) return []
    const manifest = JSON.parse(decodeURIComponent(manifestSrc.slice(prefix.length)))
    const formats = manifest.formats.filter(format => format.mimeType?.startsWith('video/') && format.height)
    log('SABR video dimensions', formats.map(format => ({ width: format.width, height: format.height, quality: format.quality })).slice(0, 12))
    const qualities = new Map()
    for (const format of formats) {
      const key = format.quality || format.height
      const current = qualities.get(key)
      if (!current || format.height > current.height) qualities.set(key, format)
    }
    const result = [...qualities.values()]
      .sort((a, b) => b.height - a.height)
      .map(format => ({
        height: format.height,
        label: `${qualityHeight(format)}p (SABR)`,
        sabr: true
      }))
    log('SABR quality candidates', result.map(format => format.label))
    return result
  } catch (error) {
    log('SABR quality parsing failed', error?.message || String(error))
    return []
  }
}

export function selectDownloadFormats(progressiveFormats, adaptiveFormats = []) {
  return getDownloadFormats(progressiveFormats, adaptiveFormats)[0] ?? null
}

const sabrOperations = new Map()
const sabrStarting = new Set()
const sabrCanceled = new Set()
const sabrPaused = new Set()
let sabrActive = 0
const sabrWaiters = []

async function acquireSabrSlot() {
  const limit = Number(localStorage.getItem('freetube-download-concurrency') || 5)
  if (sabrActive < Math.max(1, Math.min(5, limit))) {
    sabrActive++
    return
  }
  await new Promise(resolve => sabrWaiters.push(resolve))
  sabrActive++
}

function releaseSabrSlot() {
  sabrActive--
  sabrWaiters.shift()?.()
}

function readDownloadMetadata() {
  try {
    const downloads = JSON.parse(localStorage.getItem('freetube-downloads') || '[]')
    return Array.isArray(downloads) ? downloads : []
  } catch {
    return []
  }
}

export function recordDownloadMetadata(metadata) {
  const downloads = readDownloadMetadata()
  log('metadata create', { id: metadata.downloadId, selectedFormat: metadata.selectedFormat, status: metadata.status })
  downloads.push(metadata)
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
  return downloads
}

export async function storeSabrDownload(download, onProgress, maxHeight) {
  if (!download.manifestSrc || !download.sabrData || !shaka.offline?.Storage) throw new Error('SABR download is unavailable')
  sabrCanceled.delete(download.downloadId)
  sabrPaused.delete(download.downloadId)
  sabrStarting.add(download.downloadId)
  await acquireSabrSlot()
  const scheme = `sabr-${download.downloadId.replaceAll('-', '')}`
  const manifestSrc = `${download.manifestSrc}#${scheme.slice(5)}`
  log('SABR store start', { id: download.downloadId, maxHeight })
  const video = document.createElement('video')
  const player = new shaka.Player(video)
  const manifestRef = { value: null }
  let storage = null
  let lastLoggedPercent = -1
  let transportBytes = 0
  setupSabrScheme(download.sabrData, () => player, () => manifestRef.value, 640, 360, scheme, bytes => {
    transportBytes += bytes
  })
  try {
    await player.load(manifestSrc, null, download.manifestMimeType)
    manifestRef.value = player.getManifest()
    storage = new shaka.offline.Storage(player)
    storage.configure({
      offline: {
        trackSelectionCallback: maxHeight
          ? tracks => {
            const variants = tracks.filter(track => track.type === 'variant' && track.height != null)
            const heights = variants.filter(track => track.height <= maxHeight).map(track => track.height)
            const height = Math.max(...heights, Math.min(...variants.map(track => track.height)))
            return tracks.filter(track => track.type !== 'variant' || track.height === height)
          }
          : undefined,
        progressCallback(content, progress) {
          const percent = Math.round(progress * 100)
          if (percent !== lastLoggedPercent && (percent === 0 || percent === 100 || percent % 10 === 0)) {
            lastLoggedPercent = percent
            log('SABR store progress', { id: download.downloadId, percent })
          }
          const snapshot = getProgressSnapshot(content, transportBytes, progress)
          onProgress?.({ ...content, size: snapshot.received }, progress, snapshot.total)
        }
      }
    })
    const operation = storage.store(manifestSrc, {}, download.manifestMimeType)
    sabrOperations.set(download.downloadId, operation)
    const content = await operation.promise
    log('SABR store complete', { id: download.downloadId, hasOfflineUri: Boolean(content?.offlineUri) })
    if (!content?.offlineUri) {
      console.error(`[SABR] storage returned invalid content: ${JSON.stringify(content)}`)
      throw new Error('Offline storage returned no URI')
    }
    return content
  } catch (error) {
    log('SABR store failed', { id: download.downloadId, message: error?.message || String(error), code: error?.code })
    throw error
  } finally {
    sabrOperations.delete(download.downloadId)
    sabrStarting.delete(download.downloadId)
    await storage?.destroy()
    await player.destroy()
    releaseSabrSlot()
  }
}

export async function recoverSabrDownload(download, onProgress) {
  const content = await storeSabrDownload(download, onProgress)
  return content.offlineUri
}

export function hasSabrDownload(downloadId) {
  return sabrOperations.has(downloadId) || sabrStarting.has(downloadId)
}

export function cancelSabrDownload(downloadId) {
  sabrPaused.delete(downloadId)
  sabrCanceled.add(downloadId)
  sabrOperations.get(downloadId)?.abort()
}

export function pauseSabrDownload(downloadId) {
  sabrCanceled.delete(downloadId)
  sabrPaused.add(downloadId)
  sabrOperations.get(downloadId)?.abort()
}

export function isSabrDownloadCanceled(downloadId) {
  return sabrCanceled.has(downloadId)
}

export function isSabrDownloadPaused(downloadId) {
  return sabrPaused.has(downloadId)
}

export function mergeNativeDownload(download, native) {
  return {
    ...download,
    status: native.status,
    progress: native.progress,
    received: native.received,
    total: native.total,
    speedBps: native.speedBps,
    etaSeconds: native.etaSeconds,
    error: native.error
  }
}

export function getProgressSnapshot(content, transportBytes, progress) {
  const received = Math.max(content?.size || 0, transportBytes || 0)
  return {
    received,
    total: progress > 0 ? Math.round(received / progress) : 0
  }
}

export function mergeDownloadProgress(download, detail, native = null) {
  if (native) return mergeNativeDownload(download, native)
  return {
    ...download,
    status: detail.status,
    progress: detail.progress ?? (detail.total > 0 ? detail.received / detail.total : null),
    received: detail.received,
    total: detail.total,
    speedBps: detail.speedBps,
    etaSeconds: detail.etaSeconds,
    error: detail.error || null
  }
}

export function updateDownloadMetadata(downloadId, changes) {
  const downloads = readDownloadMetadata()
  const download = downloads.find(item => item.downloadId === downloadId)
  if (!download) return
  const statusChanged = changes.status && changes.status !== download.status
  Object.assign(download, changes)
  if (statusChanged || changes.offlineUri || changes.error) log('metadata update', { id: downloadId, status: changes.status, hasOfflineUri: Boolean(changes.offlineUri), error: changes.error })
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
}

function safeFileName(title, id) {
  const name = title.replaceAll(/[\\/:*?"<>|]/g, '_').replaceAll(/\s+/g, ' ').trim()
  return `${(name || id).slice(0, 180)}.mp4`
}

/**
 * Downloads one video through Android native storage.
 * @param {{id: string, title: string, videoUrl: string, audioUrl?: string|null, thumbnail?: string, sourceBackend?: string, metadata?: object}} video
 * @returns {Promise<void>}
 */
export async function downloadProgressiveVideo(video) {
  if (!process.env.IS_ANDROID || typeof android.downloadUrl !== 'function' ||
    (video.audioUrl && typeof android.muxDownload !== 'function')) {
    throw new Error('Downloads are only available on Android with native MP4 muxing')
  }

  const fileName = safeFileName(video.title, video.id)
  const directory = localStorage.getItem('freetube-download-directory') || 'data://downloads/FreetTube'
  android.setDownloadConcurrency?.(Number(localStorage.getItem('freetube-download-concurrency') || 5))
  const defaultUri = android.createDownloadFile?.(directory, `${fileName}.part`) || ''
  const dialog = defaultUri
    ? { canceled: false, uri: defaultUri }
    : await requestSaveDialog(`${fileName}.part`, 'video/mp4')
  if (dialog.canceled) return

  const downloadId = globalThis.crypto?.randomUUID?.() ?? `download-${Date.now()}`
  const eventName = 'android-download'
  const metadata = {
    downloadId,
    videoId: video.id,
    title: video.title,
    thumbnail: video.thumbnail ?? '',
    ...video.metadata,
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
        metadata.received = event.detail.received
        metadata.total = event.detail.total
        const notification = getDownloadNotificationPayload({ downloadId, title: video.title, status: metadata.status || 'downloading', progress: metadata.progress ?? 0, speedBps: metadata.speedBps || 0, received: metadata.received || 0, total: metadata.total || 0 })
        android.updateDownloadNotification?.(notification.downloadId, notification.title, metadata.status || 'downloading', notification.progress, metadata.speedBps || 0, metadata.received || 0, metadata.total || 0)
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
        android.finishDownloadNotification?.(downloadId, video.title, true)
        metadata.fileName = fileName
        metadata.completedAt = Date.now()
        localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
        resolve()
      } else if (event.detail.status === 'failed' || event.detail.status === 'canceled') {
        window.removeEventListener(eventName, onEvent)
        android.deleteFile(dialog.uri)
        metadata.status = event.detail.status
        android.finishDownloadNotification?.(downloadId, video.title, false)
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
