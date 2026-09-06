import android from 'android'

const isAndroid = process.env.IS_ANDROID

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
