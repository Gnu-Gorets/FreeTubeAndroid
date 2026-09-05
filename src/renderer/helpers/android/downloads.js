import android from 'android'
import shaka from 'shaka-player'
import { requestSaveDialog } from './dialogs'
import { setupSabrScheme } from '../player/SabrSchemePlugin'
import { DEFAULT_DOWNLOAD_CONCURRENCY } from './download-settings.mjs'
import { getDownloadNotificationPayload } from './download-notification.mjs'

const log = (...args) => console.warn('[Downloads]', ...args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg))

export function logSabrTimestamp(downloadId, event, details = {}) {
  log('SABR timestamp', { id: downloadId, event, timestamp: Date.now(), ...details })
}

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

function parseSabrFormats(manifestSrc) {
  const prefix = 'data:application/sabr+json,'
  if (!manifestSrc?.startsWith(prefix)) return []
  try {
    const manifest = JSON.parse(decodeURIComponent(manifestSrc.slice(prefix.length)))
    return Array.isArray(manifest.formats) ? manifest.formats : []
  } catch {
    return []
  }
}

export function getSabrDownloadFormats(manifestSrc) {
  try {
    const sourceFormats = parseSabrFormats(manifestSrc)
    if (!sourceFormats.some(format => format.mimeType?.startsWith('audio/mp4'))) return []
    const formats = sourceFormats.filter(format => format.mimeType?.startsWith('video/mp4') && format.height)
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
      (!selection.maxHeight || track.height <= selection.maxHeight) &&
      track.videoMimeType?.startsWith('video/mp4') &&
      track.audioMimeType?.startsWith('audio/mp4') &&
      track.originalVideoId?.startsWith(selection.videoTrackId) &&
      track.originalAudioId?.startsWith(selection.audioTrackId))
    : null
  const selected = exact || selectSabrDownloadTrack(tracks, selection.maxHeight)
  if (!selected) throw new Error('SABR download has no MP4 track')
  return [selected]
}

const sabrOperations = new Map()
const sabrStarting = new Set()
const sabrCanceled = new Set()
const sabrPaused = new Set()
let sabrActiveWeight = 0
const sabrWaiters = []
const downloadMetadataUpdatedAt = new Map()
const DOWNLOAD_PROGRESS_UPDATE_MS = 250

function sabrBudget() {
  const limit = Number(localStorage.getItem('freetube-download-concurrency') || DEFAULT_DOWNLOAD_CONCURRENCY)
  return Math.max(1, Math.min(5, limit))
}

function sabrWeight(maxHeight) {
  return Number(maxHeight) >= 1080 ? 2 : 1
}

async function acquireSabrSlot(requestedWeight) {
  const weight = Math.min(requestedWeight, sabrBudget())
  if (sabrActiveWeight + weight <= sabrBudget()) {
    sabrActiveWeight += weight
    return weight
  }
  return new Promise(resolve => sabrWaiters.push({ weight, resolve }))
}

function releaseSabrSlot(weight) {
  sabrActiveWeight -= weight
  for (let index = 0; index < sabrWaiters.length; index++) {
    const waiter = sabrWaiters[index]
    if (sabrActiveWeight + waiter.weight <= sabrBudget()) {
      sabrWaiters.splice(index, 1)
      sabrActiveWeight += waiter.weight
      waiter.resolve(waiter.weight)
      break
    }
  }
}

function readLocalDownloadMetadata() {
  try {
    const downloads = JSON.parse(localStorage.getItem('freetube-downloads') || '[]')
    return Array.isArray(downloads) ? downloads : []
  } catch {
    return []
  }
}

export function readDownloadMetadata() {
  try {
    const nativeValue = android.getDownloadMetadata?.()
    if (nativeValue) {
      const nativeDownloads = JSON.parse(nativeValue)
      if (Array.isArray(nativeDownloads)) {
        const localDownloads = readLocalDownloadMetadata()
        if (nativeDownloads.length === 0 && localDownloads.length > 0) {
          android.replaceDownloadMetadata?.(JSON.stringify(localDownloads))
          return localDownloads
        }
        return nativeDownloads
      }
    }
  } catch (error) {
    log('native metadata read failed', error?.message || String(error))
  }
  return readLocalDownloadMetadata()
}

export function writeDownloadMetadata(downloads) {
  const serialized = JSON.stringify(downloads)
  localStorage.setItem('freetube-downloads', serialized)
  if (typeof android.replaceDownloadMetadata === 'function' && !android.replaceDownloadMetadata(serialized)) {
    log('native metadata write failed')
  }
  return downloads
}

export function normalizeDownloadMetadata(downloads) {
  if (!Array.isArray(downloads)) return []
  return downloads.map(download => {
    if (!download || typeof download !== 'object' || Array.isArray(download)) return download
    const downloadId = download.downloadId || download.id || (download.videoId && `legacy-${download.videoId}-${download.createdAt || download.localPath || 'unknown'}`)
    if (!downloadId) return download
    return {
      ...download,
      downloadId,
      videoId: download.videoId || '',
      title: download.title || download.fileName || downloadId,
      thumbnail: download.thumbnail || '',
      engine: download.engine || (download.localPath ? 'native' : 'sabr')
    }
  })
}

export function upsertDownloadMetadata(metadata) {
  const downloads = readDownloadMetadata()
  const index = downloads.findIndex(item => item.downloadId === metadata.downloadId)
  if (index === -1) downloads.push(metadata)
  else downloads[index] = { ...downloads[index], ...metadata }
  return writeDownloadMetadata(downloads)
}

export function removeDownloadMetadata(downloadId) {
  return writeDownloadMetadata(readDownloadMetadata().filter(item => item.downloadId !== downloadId))
}

export function recordDownloadMetadata(metadata) {
  log('metadata create', { id: metadata.downloadId, selectedFormat: metadata.selectedFormat, status: metadata.status })
  return upsertDownloadMetadata(metadata)
}

export async function storeSabrDownload(download, onProgress, selection = {}) {
  if (!download.manifestSrc || !download.sabrData || !shaka.offline?.Storage) throw new Error('SABR download is unavailable')
  sabrPaused.delete(download.downloadId)
  sabrStarting.add(download.downloadId)
  const slotWeight = await acquireSabrSlot(sabrWeight(selection.maxHeight))
  logSabrTimestamp(download.downloadId, 'slot-acquired', { weight: slotWeight })
  const scheme = `sabr-${download.downloadId.replaceAll('-', '')}`
  const manifestSrc = `${download.manifestSrc}#${scheme.slice(5)}`
  const video = document.createElement('video')
  const player = new shaka.Player(video)
  player.configure?.({
    abr: { enabled: false },
    streaming: { bufferingGoal: 1, rebufferingGoal: 0.1, bufferBehind: 0 }
  })
  logSabrTimestamp(download.downloadId, 'player-created')
  const manifestRef = { value: null }
  let storage = null
  let lastLoggedPercent = -1
  let firstProgressLogged = false
  let transportBytes = 0
  let stableTotal = Number(selection.total) > 0 ? Number(selection.total) : 0
  let totalExact = selection.totalExact === true
  let lastTelemetryAt = Date.now()
  let lastTelemetryReceived = 0
  let lastTelemetrySpeed = 0
  let storageStarted = false
  let storageRequestNumber = null
  let mediaBodyLogged = false
  setupSabrScheme(download.sabrData, () => player, () => manifestRef.value, 640, 360, scheme, bytes => {
    transportBytes += bytes
  }, timing => {
    const storageRequestStarted = storageStarted && storageRequestNumber === null && timing.event === 'sabr-request-start'
    const firstMediaBody = timing.event === 'sabr-first-media-body' && !mediaBodyLogged
    if (timing.requestNumber === 0 || storageRequestStarted || firstMediaBody) {
      if (storageRequestStarted) storageRequestNumber = timing.requestNumber
      if (firstMediaBody) mediaBodyLogged = true
      logSabrTimestamp(download.downloadId, timing.event, { requestNumber: timing.requestNumber, status: timing.status, bytes: timing.bytes, isInit: timing.isInit })
    } else if (timing.requestNumber === storageRequestNumber) {
      logSabrTimestamp(download.downloadId, timing.event, { requestNumber: timing.requestNumber, status: timing.status, bytes: timing.bytes, isInit: timing.isInit })
    }
  })
  logSabrTimestamp(download.downloadId, 'scheme-ready')
  try {
    if (sabrPaused.has(download.downloadId) || sabrCanceled.has(download.downloadId)) throw new Error('SABR download stopped before start')
    logSabrTimestamp(download.downloadId, 'player-load-start')
    await player.load(manifestSrc, null, download.manifestMimeType)
    logSabrTimestamp(download.downloadId, 'player-load-complete')
    logSabrTimestamp(download.downloadId, 'offline-player-loaded')
    manifestRef.value = player.getManifest()
    const selectTracks = tracks => selectSabrStorageTracks(tracks, selection)
    const [selectedTrack] = selectTracks(player.getVariantTracks())
    log('SABR track selected', { id: download.downloadId, total: stableTotal, exact: totalExact, selected: { height: selectedTrack.height, video: selectedTrack.originalVideoId, audio: selectedTrack.originalAudioId } })
    storage = new shaka.offline.Storage(player)
    logSabrTimestamp(download.downloadId, 'storage-created')
    storage.configure({
      offline: {
        trackSelectionCallback: selectTracks,
        progressCallback(content, progress) {
          if (!firstProgressLogged) {
            firstProgressLogged = true
            logSabrTimestamp(download.downloadId, 'first-progress')
          }
          const now = Date.now()
          const percent = Math.round(progress * 100)
          const snapshot = getProgressSnapshot(content, progress, stableTotal, totalExact, false)
          if (snapshot.total > stableTotal) stableTotal = snapshot.total
          const progressTotal = Math.max(stableTotal, snapshot.total)
          const rawProgressValue = Number(progress)
          const progressValue = Number.isFinite(rawProgressValue)
            ? Math.min(Math.max(rawProgressValue, 0), 0.99)
            : snapshot.progress
          if (!snapshot.totalExact) totalExact = false
          const elapsed = (now - lastTelemetryAt) / 1000
          const speedBps = elapsed > 0 ? Math.max(0, Math.round((snapshot.received - lastTelemetryReceived) / elapsed)) : 0
          const speedJump = speedBps > 0 && lastTelemetrySpeed > 0 && (speedBps > lastTelemetrySpeed * 2 || speedBps * 2 < lastTelemetrySpeed)
          const mismatch = snapshot.progress < 0 || snapshot.progress > 1
          if (speedJump || mismatch || now - lastTelemetryAt >= 5000 || percent === 0 || percent === 100) {
            log('SABR telemetry', { id: download.downloadId, received: snapshot.received, total: progressTotal, networkBytes: transportBytes, totalExact: snapshot.totalExact, progress: progressValue, speedBps, speedJump, mismatch })
            lastTelemetryAt = now
            lastTelemetryReceived = snapshot.received
            lastTelemetrySpeed = speedBps
          }
          if (percent !== lastLoggedPercent && (percent === 0 || percent === 100 || percent % 10 === 0)) {
            lastLoggedPercent = percent
            log('SABR store progress', { id: download.downloadId, percent })
          }
          if (!sabrPaused.has(download.downloadId) && !sabrCanceled.has(download.downloadId)) {
            onProgress?.({ ...content, size: snapshot.received }, progressValue, progressTotal, snapshot.totalExact)
          }
        }
      }
    })
    if (sabrPaused.has(download.downloadId) || sabrCanceled.has(download.downloadId)) throw new Error('SABR download stopped before storage')
    logSabrTimestamp(download.downloadId, 'store-started')
    storageStarted = true
    const operation = storage.store(manifestSrc, {}, download.manifestMimeType)
    sabrOperations.set(download.downloadId, operation)
    const content = await operation.promise
    await new Promise(resolve => setTimeout(resolve, 100))
    if (sabrPaused.has(download.downloadId) || sabrCanceled.has(download.downloadId)) throw new Error('SABR download stopped')
    const finalSnapshot = getProgressSnapshot(content, 1, stableTotal, totalExact)
    log('SABR telemetry', { id: download.downloadId, received: finalSnapshot.received, total: finalSnapshot.total, networkBytes: transportBytes, totalExact: finalSnapshot.totalExact, progress: finalSnapshot.progress, speedBps: 0, speedJump: false, mismatch: false })
    logSabrTimestamp(download.downloadId, 'store-complete')
    log('SABR store complete', { id: download.downloadId, hasOfflineUri: Boolean(content?.offlineUri), size: content?.size || 0, estimatedTotal: stableTotal, totalExact: finalSnapshot.totalExact })
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
    releaseSabrSlot(slotWeight)
  }
}

export async function recoverSabrDownload(download, onProgress) {
  const content = await storeSabrDownload(download, onProgress, download)
  return { ...getProgressSnapshot(content, 1, download.total, download.totalExact), offlineUri: content.offlineUri }
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
  const snapshot = getProgressSnapshot({ size: native.received }, 0, native.total, native.totalExact)
  return {
    ...download,
    status: native.status,
    localPath: native.targetUri || download.localPath,
    ...snapshot,
    fileSize: native.fileSize || download.fileSize || 0,
    phase: native.phase,
    speedBps: native.speedBps,
    etaSeconds: native.etaSeconds,
    error: native.error
  }
}

export function getProgressSnapshot(content, shakaProgress, knownTotal = 0, totalExact = false, terminal = true) {
  const received = Math.max(Number(content?.size) || 0, 0)
  const known = Number(knownTotal)
  const rawProgress = Number(shakaProgress)
  if (terminal && rawProgress >= 1 && received > 0) return { received, total: received, totalExact: true, progress: 1 }
  const hasKnownTotal = Number.isFinite(known) && known > 0
  const canEstimate = !hasKnownTotal && Number.isFinite(rawProgress) && rawProgress > 0 && received > 0
  const total = hasKnownTotal
    ? Math.max(known, received)
    : canEstimate ? Math.max(received, Math.round(received / rawProgress)) : 0
  return {
    received,
    total,
    totalExact: hasKnownTotal && received <= known && totalExact === true,
    progress: total > 0 ? Math.min(received / total, 1) : null
  }
}

export async function preflightSabrDownload(player, manifestSrc, maxHeight) {
  const manifest = player?.getManifest?.()
  const selectedTrack = selectSabrDownloadTrack(player?.getVariantTracks?.() || [], maxHeight)
  if (!manifest) throw new Error('SABR download is not ready')
  const formats = parseSabrFormats(manifestSrc)
  const pick = (mimeType, height = Infinity) => formats
    .filter(format => format.mimeType?.startsWith(mimeType) && (height === Infinity || (Number.isFinite(format.height) && format.height <= height)))
    .sort((a, b) => (b.height - a.height) || ((b.bitrate || 0) - (a.bitrate || 0)))[0]
  const formatId = format => `${format.itag}-${format.lastModified}-`
  const find = id => formats.find(format => id?.startsWith(formatId(format)))
  const selectedVideo = selectedTrack && find(selectedTrack.originalVideoId)
  const selectedAudio = selectedTrack && find(selectedTrack.originalAudioId)
  const selectedIsEligible = selectedTrack && selectedTrack.height <= (maxHeight || Infinity) && selectedVideo && selectedAudio && (!selectedVideo.mimeType || selectedVideo.mimeType.startsWith('video/mp4')) && (!selectedAudio.mimeType || selectedAudio.mimeType.startsWith('audio/mp4'))
  const video = selectedIsEligible ? selectedVideo : pick('video/mp4', maxHeight) || pick('video/mp4')
  const audio = selectedIsEligible ? selectedAudio : pick('audio/mp4')
  if (!video || !audio) throw new Error('SABR download is not ready')
  const videoLength = Number(video?.contentLength)
  const audioLength = Number(audio?.contentLength)
  if ([videoLength, audioLength].every(value => Number.isFinite(value) && Number.isInteger(value) && value > 0)) {
    return {
      videoId: selectedTrack?.originalVideoId?.startsWith(formatId(video)) ? selectedTrack.originalVideoId : formatId(video),
      audioId: selectedTrack?.originalAudioId?.startsWith(formatId(audio)) ? selectedTrack.originalAudioId : formatId(audio),
      total: videoLength + audioLength,
      totalExact: true
    }
  }
  if (!selectedTrack) throw new Error('SABR download is not ready')
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
  const snapshot = getProgressSnapshot(
    { size: detail.received ?? download.received },
    detail.progress ?? download.progress,
    detail.total ?? download.total,
    detail.totalExact ?? download.totalExact,
    detail.status !== 'downloading'
  )
  const activeProgress = detail.status === 'downloading' && Number.isFinite(Number(detail.progress))
    ? Math.min(Math.max(Number(detail.progress), 0), 0.99)
    : snapshot.progress
  return {
    ...download,
    ...detail,
    status: detail.status ?? download.status,
    ...snapshot,
    progress: activeProgress,
    fileSize: detail.fileSize || download.fileSize || 0,
    phase: detail.phase ?? download.phase,
    speedBps: detail.speedBps,
    etaSeconds: detail.etaSeconds,
    error: detail.error || null
  }
}

export function updateDownloadMetadata(downloadId, changes) {
  const now = Date.now()
  const lastUpdatedAt = downloadMetadataUpdatedAt.get(downloadId) || 0
  const nearCompletion = Number(changes.progress) >= 0.99
  if (changes.status === 'downloading' && !nearCompletion && now - lastUpdatedAt < DOWNLOAD_PROGRESS_UPDATE_MS) return
  const downloads = readDownloadMetadata()
  const download = downloads.find(item => item.downloadId === downloadId)
  if (!download) return
  if (changes.status === 'downloading' && changes.total > 0 && download.total > changes.total) {
    const received = Number(changes.received) || 0
    changes = { ...changes, total: download.total, progress: Math.min(received / download.total, 1) }
  }
  if (changes.status === 'downloading' && Number(changes.speedBps) > 0 && Number(download.speedBps) > 0) {
    const previousSpeed = Number(download.speedBps)
    const speedBps = Number(changes.speedBps)
    changes = { ...changes, speedBps: Math.min(previousSpeed * 1.5, Math.max(previousSpeed / 1.5, speedBps)) }
  }
  const statusChanged = changes.status && changes.status !== download.status
  Object.assign(download, changes)
  if (statusChanged || changes.phase || changes.offlineUri || changes.error || changes.speedBps != null) log('metadata update', { id: downloadId, status: changes.status, phase: changes.phase, hasOfflineUri: Boolean(changes.offlineUri), error: changes.error, received: changes.received, total: changes.total, totalExact: changes.totalExact, speedBps: changes.speedBps })
  writeDownloadMetadata(downloads)
  if (changes.status === 'downloading') downloadMetadataUpdatedAt.set(downloadId, now)
  else downloadMetadataUpdatedAt.delete(downloadId)
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

/**
 * Downloads one video through Android native storage.
 * @param {{id: string, title: string, videoUrl: string, audioUrl?: string|null, thumbnail?: string, sourceBackend?: string, metadata?: object}} video
 * @returns {Promise<void>}
 */
export async function downloadProgressiveVideo(video) {
  if (!process.env.IS_ANDROID || typeof android.enqueueNativeDownload !== 'function') {
    throw new Error('Downloads are only available on Android with native MP4 muxing')
  }

  const fileName = safeFileName(video.title, video.id)
  const positiveBytes = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0
  const videoTotal = positiveBytes(video.videoTotal)
  const audioTotal = positiveBytes(video.audioTotal)
  const suppliedTotal = positiveBytes(video.total)
  const total = video.audioUrl ? (videoTotal > 0 && audioTotal > 0 ? videoTotal + audioTotal : 0) : suppliedTotal || videoTotal
  const totalExact = total > 0
  android.setDownloadConcurrency?.(Number(localStorage.getItem('freetube-download-concurrency') || DEFAULT_DOWNLOAD_CONCURRENCY))
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
    progress: null,
    createdAt: Date.now()
  }
  const downloads = recordDownloadMetadata(metadata)
  const queued = android.enqueueNativeDownload(JSON.stringify({
    id: downloadId,
    title: video.title,
    videoUrl: video.videoUrl,
    audioUrl: video.audioUrl || '',
    videoTotal,
    audioTotal,
    total,
    totalExact,
    targetUri: dialog.uri,
    finalName: fileName
  }))
  if (!queued) throw new Error('Unable to queue download')
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const item = JSON.parse(android.getNativeDownloadQueue?.() || '[]').find(entry => entry.id === downloadId)
        if (!item) return
        Object.assign(metadata, mergeNativeDownload(metadata, item))
        if (item.status === 'completed') {
          metadata.fileName = fileName
          metadata.completedAt ??= Date.now()
        }
        writeDownloadMetadata(downloads)
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
