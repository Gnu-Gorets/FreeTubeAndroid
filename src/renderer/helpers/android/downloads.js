import android from 'android'
import { awaitAsyncResult } from './jsinterface'

const isAndroid = process.env.IS_ANDROID

const DOWNLOAD_DIRECTORY_KEY = 'android-download-directory'

export async function selectDownloadDirectory(force = false) {
  if (!isAndroid) return null
  if (!force) {
    const saved = localStorage.getItem(DOWNLOAD_DIRECTORY_KEY)
    if (saved && android.isTreeAccessible(saved)) return saved
    if (typeof android.getDownloadDirectory === 'function') return android.getDownloadDirectory()
  }
  const uri = await awaitAsyncResult(android.requestDirectoryAccessDialog())
  if (uri === 'USER_CANCELED') return null
  localStorage.setItem(DOWNLOAD_DIRECTORY_KEY, uri)
  return uri
}

export function getDownloadDirectory() {
  if (!isAndroid) return null
  return localStorage.getItem(DOWNLOAD_DIRECTORY_KEY) || (typeof android.getDownloadDirectory === 'function' ? android.getDownloadDirectory() : null)
}

export function resetDownloadDirectory() {
  if (!isAndroid) return
  const uri = getDownloadDirectory()
  if (uri) android.revokeDownloadDirectory(uri)
  localStorage.removeItem(DOWNLOAD_DIRECTORY_KEY)
}

export function getDownloads() {
  return isAndroid ? JSON.parse(android.getDownloads()) : []
}

export function getDownloadSettings() {
  return isAndroid ? JSON.parse(android.getDownloadSettings()) : { wifiOnly: false, concurrency: 1 }
}

export function updateDownloadSettings(settings) {
  return isAndroid && android.updateDownloadSettings(JSON.stringify(settings))
}

export function probeDownloadUrls(request) {
  if (!isAndroid) return []
  return JSON.parse(android.probeDownloadUrls(JSON.stringify(request)))
}

export function validateDownloadUrls(request) {
  if (!isAndroid) return { ok: false, error: 'Downloads are only supported on Android' }
  return JSON.parse(android.validateDownloadUrls(JSON.stringify(request)))
}

export function enqueueDownload(request) {
  if (!isAndroid) throw new Error('Downloads are only supported on Android')
  return android.enqueueDownload(JSON.stringify(request))
}

export function pauseDownload(id) {
  return isAndroid && android.pauseDownload(id)
}

export function resumeDownload(id) {
  return isAndroid && android.resumeDownload(id)
}

export function cancelDownload(id) {
  return isAndroid && android.cancelDownload(id)
}

export function retryDownload(id) {
  return isAndroid && android.retryDownload(id)
}

export function refreshDownload(id, request) {
  return isAndroid && android.refreshDownload(id, JSON.stringify(request))
}

export function deleteDownload(id) {
  return isAndroid && android.deleteDownload(id)
}

export function openDownload(uri, mimeType) {
  return isAndroid && android.openDownloadFile(uri, mimeType)
}

export function shareDownload(uri, mimeType) {
  if (isAndroid) android.shareFile(uri, mimeType)
}
