import android from 'android'
import shaka from 'shaka-player'
import { requestSaveDialog } from './dialogs'
import { awaitAsyncResult } from './jsinterface'
import { writeFile } from './storage'
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

function parseSabrManifest(manifestSrc) {
  const prefix = 'data:application/sabr+json,'
  if (!manifestSrc?.startsWith(prefix)) return null
  try {
    const manifest = JSON.parse(decodeURIComponent(manifestSrc.slice(prefix.length)))
    return Array.isArray(manifest.formats) ? manifest : null
  } catch {
    return null
  }
}

export function getSabrDownloadFormats(manifestSrc) {
  try {
    const manifest = parseSabrManifest(manifestSrc)
    if (!manifest || !manifest.formats.some(format => format.mimeType?.startsWith('audio/mp4'))) return []
    const formats = manifest.formats.filter(format => format.mimeType?.startsWith('video/mp4') && format.height)
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

export function selectSabrDownloadTrack(tracks = [], maxHeight) {
  const variants = tracks.filter(track => track.type === 'variant' && Number.isFinite(track.height))
  const compatible = variants.filter(track => track.videoMimeType?.startsWith('video/mp4') && track.audioMimeType?.startsWith('audio/mp4'))
  const eligible = compatible.filter(track => track.height <= (maxHeight || Infinity))
  const candidates = eligible.length > 0 ? eligible : compatible
  const height = eligible.length > 0
    ? Math.max(...candidates.map(track => track.height))
    : Math.min(...candidates.map(track => track.height))
  return candidates.filter(track => track.height === height)
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] ?? null
}

function selectSabrStorageTracks(tracks = [], selection = {}) {
  const exact = selection.videoTrackId && selection.audioTrackId
    ? tracks.find(track => track.type === 'variant' &&
      Number.isFinite(track.height) &&
      track.videoMimeType?.startsWith('video/mp4') &&
      track.audioMimeType?.startsWith('audio/mp4') &&
      track.originalVideoId === selection.videoTrackId &&
      track.originalAudioId === selection.audioTrackId)
    : null
  const selected = exact || selectSabrDownloadTrack(tracks, selection.maxHeight)
  if (!selected) throw new Error('SABR download has no MP4 track')
  return [selected]
}

const sabrOperations = new Map()
const sabrStarting = new Set()
const sabrCanceled = new Set()
const sabrPaused = new Set()
let sabrActive = 0
const sabrWaiters = []

async function acquireSabrSlot() {
  const limit = Number(localStorage.getItem('freetube-download-concurrency') || 1)
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

export async function storeSabrDownload(download, onProgress, selection = {}) {
  if (!download.manifestSrc || !download.sabrData || !shaka.offline?.Storage) throw new Error('SABR download is unavailable')
  sabrCanceled.delete(download.downloadId)
  sabrPaused.delete(download.downloadId)
  sabrStarting.add(download.downloadId)
  await acquireSabrSlot()
  const scheme = `sabr-${download.downloadId.replaceAll('-', '')}`
  const manifestSrc = `${download.manifestSrc}#${scheme.slice(5)}`
  log('SABR store start', { id: download.downloadId, maxHeight: selection.maxHeight })
  const video = document.createElement('video')
  const player = new shaka.Player(video)
  const manifestRef = { value: null }
  let storage = null
  let lastLoggedPercent = -1
  let transportBytes = 0
  let stableTotal = Number(selection.total) > 0 ? Number(selection.total) : 0
  let totalExact = selection.totalExact === true
  let lastTelemetryAt = Date.now()
  let lastTelemetryReceived = 0
  let lastTelemetrySpeed = 0
  setupSabrScheme(download.sabrData, () => player, () => manifestRef.value, 640, 360, scheme, bytes => {
    transportBytes += bytes
  })
  try {
    if (sabrPaused.has(download.downloadId) || sabrCanceled.has(download.downloadId)) throw new Error('SABR download stopped before start')
    await player.load(manifestSrc, null, download.manifestMimeType)
    manifestRef.value = player.getManifest()
    const selectTracks = tracks => selectSabrStorageTracks(tracks, selection)
    const [selectedTrack] = selectTracks(player.getVariantTracks())
    log('SABR track selected', { id: download.downloadId, total: stableTotal, exact: totalExact, selected: { height: selectedTrack.height, video: selectedTrack.originalVideoId, audio: selectedTrack.originalAudioId } })
    storage = new shaka.offline.Storage(player)
    storage.configure({
      offline: {
        trackSelectionCallback: selectTracks,
        progressCallback(content, progress) {
          const now = Date.now()
          const percent = Math.round(progress * 100)
          const snapshot = getStableProgressSnapshot(content, transportBytes, progress, stableTotal, totalExact)
          if (snapshot.total > stableTotal) stableTotal = snapshot.total
          if (!snapshot.totalExact) totalExact = false
          const elapsed = (now - lastTelemetryAt) / 1000
          const speedBps = elapsed > 0 ? Math.max(0, Math.round((snapshot.received - lastTelemetryReceived) / elapsed)) : 0
          const speedJump = speedBps > 0 && lastTelemetrySpeed > 0 && (speedBps > lastTelemetrySpeed * 2 || speedBps * 2 < lastTelemetrySpeed)
          const mismatch = snapshot.progress < 0 || snapshot.progress > 1
          if (speedJump || mismatch || now - lastTelemetryAt >= 5000 || percent === 0 || percent === 100) {
            log('SABR telemetry', { id: download.downloadId, received: snapshot.received, total: snapshot.total, networkBytes: transportBytes, totalExact: snapshot.totalExact, progress: snapshot.progress, speedBps, speedJump, mismatch })
            lastTelemetryAt = now
            lastTelemetryReceived = snapshot.received
            lastTelemetrySpeed = speedBps
          }
          if (percent !== lastLoggedPercent && (percent === 0 || percent === 100 || percent % 10 === 0)) {
            lastLoggedPercent = percent
            log('SABR store progress', { id: download.downloadId, percent })
          }
          if (!sabrPaused.has(download.downloadId) && !sabrCanceled.has(download.downloadId)) {
            onProgress?.({ ...content, size: snapshot.received }, snapshot.progress, snapshot.total, transportBytes, snapshot.totalExact)
          }
        }
      }
    })
    if (sabrPaused.has(download.downloadId) || sabrCanceled.has(download.downloadId)) throw new Error('SABR download stopped before storage')
    const operation = storage.store(manifestSrc, {}, download.manifestMimeType)
    sabrOperations.set(download.downloadId, operation)
    const content = await operation.promise
    if (sabrPaused.has(download.downloadId) || sabrCanceled.has(download.downloadId)) throw new Error('SABR download stopped')
    log('SABR store complete', { id: download.downloadId, hasOfflineUri: Boolean(content?.offlineUri), size: content?.size || 0, estimatedTotal: stableTotal, totalExact })
    if (!content?.offlineUri || !(content?.size > 0)) {
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
  if (download.status === 'processing' && download.offlineUri) {
    return { ...await exportSabrDownload(download, download.title, download.downloadId), offlineUri: download.offlineUri }
  }
  const content = await storeSabrDownload(download, onProgress, download)
  return { ...await exportSabrDownload(content, download.title, download.downloadId), offlineUri: content.offlineUri }
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
    localPath: native.targetUri || download.localPath,
    progress: native.total > 0 ? Math.min(Math.max(native.received / native.total, 0), 1) : null,
    received: native.received ?? 0,
    total: native.total ?? 0,
    fileSize: native.fileSize || download.fileSize || 0,
    totalExact: native.totalExact === true,
    phase: native.phase,
    speedBps: native.speedBps,
    etaSeconds: native.etaSeconds,
    error: native.error
  }
}

export function getProgressSnapshot(content, _transportBytes, progress, knownTotal = 0, totalExact = false) {
  const received = Math.max(Number(content?.size) || 0, 0)
  let total = Number(knownTotal) > 0 ? Number(knownTotal) : (progress > 0 ? Math.round(received / progress) : 0)
  let exact = totalExact === true
  if (total > 0 && received > total) { total = received; exact = false }
  return { received, total, totalExact: exact }
}

export function getStableProgressSnapshot(content, transportBytes, progress, knownTotal = 0, totalExact = false) {
  const snapshot = getProgressSnapshot(content, transportBytes, progress, knownTotal, totalExact)
  return { ...snapshot, progress: snapshot.total > 0 ? snapshot.received / snapshot.total : null }
}

export async function preflightSabrDownload(player, manifestSrc, maxHeight) {
  const manifest = player?.getManifest?.()
  const selectedTrack = selectSabrDownloadTrack(player?.getVariantTracks?.() || [], maxHeight)
  if (!manifest || !selectedTrack) throw new Error('SABR download is not ready')
  const formats = parseSabrManifest(manifestSrc)?.formats || []
  const find = id => formats.find(format => id?.startsWith(`${format.itag}-${format.lastModified}-`))
  const videoLength = Number(find(selectedTrack.originalVideoId)?.contentLength)
  const audioLength = Number(find(selectedTrack.originalAudioId)?.contentLength)
  if ([videoLength, audioLength].every(value => Number.isInteger(value) && value > 0)) {
    return { videoId: selectedTrack.originalVideoId, audioId: selectedTrack.originalAudioId, total: videoLength + audioLength, totalExact: true }
  }
  const estimate = await estimateSabrSize(manifest, selectedTrack)
  return { videoId: selectedTrack.originalVideoId, audioId: selectedTrack.originalAudioId, total: estimate.total, totalExact: false }
}

async function estimateSabrSize(manifest, selectedTrack) {
  const selected = manifest?.variants?.find(variant =>
    variant.video?.originalId === selectedTrack?.originalVideoId &&
    variant.audio?.originalId === selectedTrack?.originalAudioId)
  const streams = [selected?.video, selected?.audio].filter(Boolean)
  await Promise.all(streams.map(stream => stream.createSegmentIndex?.()))
  let total = 0
  let exact = streams.length > 0
  for (const stream of streams) {
    const initSize = stream.segmentIndex?.get(0)?.initSegmentReference?.getSize?.() || 0
    const references = stream.segmentIndex?.getNumReferences?.() || 0
    let segmentSize = 0
    if (references === 0 || initSize <= 0) exact = false
    for (let index = 0; index < references; index++) {
      const reference = stream.segmentIndex.get(index)
      const start = reference?.getStartByte()
      const end = reference?.getEndByte()
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) segmentSize += end - start + 1
      else exact = false
    }
    total += initSize + segmentSize
  }
  if (total > 0) return { total, exact }
  return { total: (selected?.video?.size || 0) + (selected?.audio?.size || 0), exact: false }
}

export function mergeDownloadProgress(download, detail, native = null) {
  if (native) return mergeNativeDownload(download, native)
  return {
    ...download,
    status: detail.status,
    progress: detail.total > 0 ? Math.min(Math.max(detail.received / detail.total, 0), 1) : null,
    received: detail.received ?? 0,
    total: detail.total ?? 0,
    fileSize: detail.fileSize || download.fileSize || 0,
    totalExact: detail.totalExact ?? download.totalExact,
    networkBytes: detail.networkBytes ?? download.networkBytes,
    phase: detail.phase ?? download.phase,
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
  if (statusChanged || changes.offlineUri || changes.error || changes.speedBps != null) log('metadata update', { id: downloadId, status: changes.status, hasOfflineUri: Boolean(changes.offlineUri), error: changes.error, received: changes.received, total: changes.total, networkBytes: changes.networkBytes, totalExact: changes.totalExact, speedBps: changes.speedBps })
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('android-download', { detail: { id: downloadId, ...changes } }))
  }
}

function safeFileName(title, id) {
  const name = title.replaceAll(/[\\/:*?"<>|]/g, '_').replaceAll(/\s+/g, ' ').trim()
  return `${(name || id).slice(0, 180)}.mp4`
}

function downloadDirectory() {
  const stored = localStorage.getItem('freetube-download-directory')
  return !stored || ['data://downloads', 'data://downloads/Freetube', 'data://downloads/FreetTube'].includes(stored)
    ? 'data://downloads/FreeTube'
    : stored
}

function idbValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function writeOfflineStream(db, stream, uri) {
  let append = false
  const writtenInitSegments = new Set()
  for (const segment of [...stream.segments].sort((a, b) => a.startTime - b.startTime)) {
    const keys = []
    if (segment.initSegmentKey != null && !writtenInitSegments.has(segment.initSegmentKey)) {
      writtenInitSegments.add(segment.initSegmentKey)
      keys.push(segment.initSegmentKey)
    }
    keys.push(segment.dataKey)
    for (const key of keys) {
      const stored = await idbValue(db.transaction('segment-v5').objectStore('segment-v5').get(key))
      if (!stored?.data) throw new Error(`Offline segment ${key} is unavailable`)
      await writeFile(uri, new Blob([stored.data]), append)
      append = true
    }
  }
  if (!append) throw new Error(`Offline ${stream.type} stream is empty`)
}

export async function exportSabrDownload(content, title, downloadId) {
  if (!content?.offlineUri || typeof android.muxStoredDownload !== 'function') throw new Error('SABR MP4 export is unavailable')
  const match = /^offline:manifest\/idb\/v5\/([0-9]+)$/.exec(content.offlineUri)
  if (!match) throw new Error('Unsupported SABR offline URI')
  const fileName = safeFileName(title, downloadId)
  const videoUri = `data://sabr/${downloadId}-video.mp4`
  const audioUri = `data://sabr/${downloadId}-audio.mp4`
  let targetUri = ''
  const db = await idbValue(indexedDB.open('shaka_offline_db'))
  try {
    const manifest = await idbValue(db.transaction('manifest-v5').objectStore('manifest-v5').get(Number(match[1])))
    const video = manifest?.streams?.find(stream => stream.type === 'video' && stream.mimeType === 'video/mp4')
    const audio = manifest?.streams?.find(stream => stream.type === 'audio' && stream.mimeType === 'audio/mp4')
    if (!video || !audio) throw new Error('Offline MP4 tracks are unavailable')
    await Promise.all([
      writeOfflineStream(db, video, videoUri),
      writeOfflineStream(db, audio, audioUri)
    ])
    targetUri = android.createDownloadFile?.(downloadDirectory(), `${fileName}.part`) || ''
    if (!targetUri) {
      const dialog = await requestSaveDialog(fileName, 'video/mp4')
      if (dialog.canceled) throw new Error('SABR MP4 export canceled')
      targetUri = dialog.uri
    }
    const localPath = await awaitAsyncResult(android.muxStoredDownload(videoUri, audioUri, targetUri, fileName))
    return { fileName, localPath, fileSize: android.getFileSize?.(localPath) || 0 }
  } catch (error) {
    if (targetUri) android.deleteFile?.(targetUri)
    throw error
  } finally {
    db.close()
    android.deleteFile?.(videoUri)
    android.deleteFile?.(audioUri)
  }
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
  const total = video.total || (video.audioUrl && video.videoTotal > 0 && video.audioTotal > 0 ? video.videoTotal + video.audioTotal : video.videoTotal)
  const totalExact = total > 0 && (!video.audioUrl || (video.videoTotal > 0 && video.audioTotal > 0))
  android.setDownloadConcurrency?.(Number(localStorage.getItem('freetube-download-concurrency') || 1))
  const defaultUri = android.createDownloadFile?.(downloadDirectory(), `${fileName}.part`) || ''
  const dialog = defaultUri
    ? { canceled: false, uri: defaultUri }
    : await requestSaveDialog(fileName, 'video/mp4')
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
    engine: 'native',
    selectedFormat: video.selectedFormat || (video.audioUrl ? 'adaptive-mp4' : 'progressive'),
    localPath: dialog.uri,
    status: 'queued',
    received: 0,
    total,
    totalExact,
    progress: total > 0 ? 0 : null,
    createdAt: Date.now()
  }
  const downloads = recordDownloadMetadata(metadata)
  if (typeof android.enqueueNativeDownload === 'function') {
    const queued = android.enqueueNativeDownload(JSON.stringify({
      id: downloadId,
      title: video.title,
      videoUrl: video.videoUrl,
      audioUrl: video.audioUrl || '',
      videoTotal: video.videoTotal || 0,
      audioTotal: video.audioTotal || 0,
      total,
      targetUri: dialog.uri,
      finalName: fileName
    }))
    if (!queued) throw new Error('Unable to queue download')
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          const item = JSON.parse(android.getNativeDownloadQueue?.() || '[]').find(entry => entry.id === downloadId)
          if (!item) return
          Object.assign(metadata, {
            status: item.status,
            progress: item.progress ?? null,
            received: item.received ?? 0,
            total: item.total ?? 0,
            fileSize: item.fileSize ?? 0,
            totalExact: item.totalExact === true,
            speedBps: item.speedBps ?? 0,
            etaSeconds: item.etaSeconds ?? 0,
            error: item.error || null
          })
          if (item.status === 'completed') {
            metadata.fileName = fileName
            metadata.completedAt ??= Date.now()
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
        android.finishDownloadNotification?.(downloadId)
        metadata.fileName = fileName
        metadata.completedAt = Date.now()
        localStorage.setItem('freetube-downloads', JSON.stringify(downloads))
        resolve()
      } else if (event.detail.status === 'failed' || event.detail.status === 'canceled') {
        window.removeEventListener(eventName, onEvent)
        android.deleteFile(dialog.uri)
        metadata.status = event.detail.status
        android.finishDownloadNotification?.(downloadId)
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
