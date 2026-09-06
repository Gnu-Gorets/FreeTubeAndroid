import android from 'android'
import { awaitAsyncResult } from './jsinterface'

const isAndroid = process.env.IS_ANDROID

export async function selectDownloadDirectory() {
  if (!isAndroid) return null
  const uri = await awaitAsyncResult(android.requestDirectoryAccessDialog())
  return uri === 'USER_CANCELED' ? null : uri
}

export function getDownloads() {
  return isAndroid ? JSON.parse(android.getDownloads()) : []
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

export function deleteDownload(id) {
  return isAndroid && android.deleteDownload(id)
}

export function openDownload(uri, mimeType) {
  return isAndroid && android.openDownloadFile(uri, mimeType)
}

export function shareDownload(uri, mimeType) {
  if (isAndroid) android.shareFile(uri, mimeType)
}
