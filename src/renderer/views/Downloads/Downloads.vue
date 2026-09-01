<template>
  <section class="downloadsView">
    <div class="downloadsHeader">
      <h1>{{ t('Downloads.Title') }}</h1>
      <label class="downloadsSearch">
        <span class="visuallyHidden">{{ t('Downloads.Search') }}</span>
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="t('Downloads.Search')"
        >
      </label>
    </div>
    <p
      v-if="downloads.length === 0"
    >
      {{ t('Downloads.Empty') }}
    </p>
    <p
      v-else-if="filteredDownloads.length === 0"
    >
      {{ t('Downloads.No matches') }}
    </p>
    <article
      v-for="download in filteredDownloads"
      :key="download.offlineUri || download.localPath || download.downloadId"
      class="downloadItem"
    >
      <img
        :src="download.thumbnail || ''"
        alt=""
        class="downloadThumbnail"
      >
      <div class="downloadInfo">
        <h2>{{ download.title }}</h2>
        <p>{{ download.status }}</p>
        <p
          v-if="download.selectedFormat"
        >
          {{ download.selectedFormat }}
        </p>
        <p
          v-if="download.status === 'downloading'"
        >
          {{ formatProgress(download) }}
        </p>
        <progress
          v-if="download.status === 'downloading' && download.progress !== null"
          max="1"
          :value="download.progress"
          :aria-label="t('Downloads.Progress')"
        />
        <div class="downloadActions">
          <button
            v-if="download.status === 'completed'"
            type="button"
            @click="play(download)"
          >
            {{ t('Downloads.Play') }}
          </button>
          <button
            v-if="download.status === 'failed'"
            type="button"
            @click="retry(download)"
          >
            {{ t('Downloads.Retry') }}
          </button>
          <button
            v-if="download.status === 'downloading'"
            type="button"
            @click="control(download, 'pause')"
          >
            {{ t('Downloads.Pause') }}
          </button>
          <button
            v-if="download.status === 'paused'"
            type="button"
            @click="control(download, 'resume')"
          >
            {{ t('Downloads.Resume') }}
          </button>
          <button
            v-if="['queued', 'downloading', 'paused'].includes(download.status)"
            type="button"
            @click="control(download, 'cancel')"
          >
            {{ t('Downloads.Cancel') }}
          </button>
          <button
            type="button"
            @click="remove(download)"
          >
            {{ t('Downloads.Delete') }}
          </button>
        </div>
      </div>
    </article>
  </section>
</template>

<script setup>
import shaka from 'shaka-player'
import android from 'android'
import { cancelSabrDownload, hasSabrDownload, isSabrDownloadCanceled, isSabrDownloadPaused, mergeDownloadProgress, mergeNativeDownload, pauseSabrDownload, recoverSabrDownload, updateDownloadMetadata } from '../../helpers/android/downloads'
import { filterDownloads } from '../../helpers/android/download-search.mjs'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const router = useRouter()
const downloads = ref([])
const searchQuery = ref('')
const filteredDownloads = computed(() => filterDownloads(downloads.value, searchQuery.value))
let queueTimer = null

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function formatProgress(download) {
  const percent = Number.isFinite(download.progress) ? `${Math.round(download.progress * 100)}%` : '…'
  const bytes = download.total > 0 ? `${formatBytes(download.received || 0)} / ${formatBytes(download.total)}` : formatBytes(download.received)
  const speed = download.speedBps > 0 ? `${formatBytes(download.speedBps)}/s` : '—'
  return `${percent} · ${bytes} · ${speed}`
}

function nativeQueue() {
  try {
    return JSON.parse(window.Android?.getNativeDownloadQueue?.() || '[]')
  } catch {
    return []
  }
}

function load() {
  try {
    const queue = nativeQueue()
    const stored = JSON.parse(localStorage.getItem('freetube-downloads') || '[]')
    if (!Array.isArray(stored)) throw new Error('Downloads metadata is not an array')
    downloads.value = stored.map(download => {
      const native = queue.find(item => item.id === download.downloadId)
      if (native) return mergeNativeDownload(download, native)
      return download.status === 'downloading' && !download.interrupted && !hasSabrDownload(download.downloadId)
        ? { ...download, status: 'queued', interrupted: true, error: 'Download interrupted' }
        : download
    })
    localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
    console.warn('[Downloads] list loaded', downloads.value.map(download => ({ id: download.downloadId, status: download.status, selectedFormat: download.selectedFormat, hasThumbnail: Boolean(download.thumbnail), hasOfflineUri: Boolean(download.offlineUri) })))
  } catch (error) {
    console.error('[Downloads] unable to load metadata', error)
    downloads.value = []
  }
}

async function retry(download) {
  if (nativeQueue().some(item => item.id === download.downloadId)) {
    control(download, 'retry')
    return
  }
  if (download.manifestSrc && download.sabrData) {
    download.status = 'queued'
    download.interrupted = true
    download.error = null
    updateDownloadMetadata(download.downloadId, { status: 'queued', interrupted: true, error: null })
    console.warn('[Downloads] SABR retry requested', { id: download.downloadId, selectedFormat: download.selectedFormat })
    recoverSabrDownloads()
    return
  }
  router.push(`/watch/${download.videoId}`)
}

function control(download, action) {
  if (download.manifestSrc) {
    if (action === 'cancel' || action === 'pause') {
      if (action === 'pause') pauseSabrDownload(download.downloadId)
      else cancelSabrDownload(download.downloadId)
      download.status = action === 'pause' ? 'paused' : 'canceled'
      updateDownloadMetadata(download.downloadId, { status: download.status, interrupted: action === 'pause', error: null })
      if (action === 'pause') {
        android.updateDownloadNotification?.(download.downloadId, download.title, 'paused', Math.round((download.progress || 0) * 100), download.speedBps || 0, download.received || 0, download.total || 0)
      } else {
        android.finishDownloadNotification?.(download.downloadId, download.title, false)
      }
    } else if (action === 'resume' || action === 'retry') {
      download.status = 'queued'
      download.interrupted = true
      updateDownloadMetadata(download.downloadId, { status: 'queued', interrupted: true, error: null })
      recoverSabrDownloads()
    }
    load()
    return
  }
  window.Android?.controlNativeDownload?.(action, download.downloadId)
  setTimeout(load, 100)
}

function play(download) {
  console.warn('[Downloads] playback start', { id: download.downloadId, status: download.status, hasOfflineUri: Boolean(download.offlineUri), hasThumbnail: Boolean(download.thumbnail) })
  router.push({ path: `/watch/${download.videoId}`, query: { offline: download.downloadId } })
}

async function remove(download) {
  console.warn('[Downloads] remove start', { id: download.downloadId, hasOfflineUri: Boolean(download.offlineUri), status: download.status })
  if (download.offlineUri) {
    const player = new shaka.Player(document.createElement('video'))
    const storage = new shaka.offline.Storage(player)
    try {
      await storage.remove(download.offlineUri)
    } finally {
      await storage.destroy()
      await player.destroy()
    }
  } else {
    window.Android?.deleteFile(download.localPath)
  }
  if (['queued', 'downloading', 'paused'].includes(download.status)) control(download, 'cancel')
  downloads.value = downloads.value.filter(item => item.downloadId !== download.downloadId)
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  console.warn('[Downloads] remove complete', { id: download.downloadId, remaining: downloads.value.length })
}

async function recoverSabrDownloads() {
  const download = downloads.value.find(item => item.status === 'queued' && item.interrupted && item.manifestSrc && item.sabrData)
  if (!download) return
  download.status = 'downloading'
  download.progress = 0
  updateDownloadMetadata(download.downloadId, { status: 'downloading', progress: 0 })
  try {
    download.offlineUri = await recoverSabrDownload(download, (_, progress) => {
      download.progress = progress
      updateDownloadMetadata(download.downloadId, { status: 'downloading', progress })
    })
    download.status = 'completed'
    download.progress = 1
    download.interrupted = false
    updateDownloadMetadata(download.downloadId, {
      status: 'completed',
      progress: 1,
      offlineUri: download.offlineUri,
      completedAt: Date.now(),
      interrupted: false
    })
  } catch (error) {
    if (isSabrDownloadPaused(download.downloadId)) {
      download.status = 'paused'
      download.error = null
      updateDownloadMetadata(download.downloadId, { status: 'paused', interrupted: true, error: null })
      return
    }
    if (isSabrDownloadCanceled(download.downloadId)) {
      download.status = 'canceled'
      download.error = null
      updateDownloadMetadata(download.downloadId, { status: 'canceled', error: null })
      return
    }
    download.status = 'failed'
    download.error = error.message || 'SABR recovery failed'
    updateDownloadMetadata(download.downloadId, { status: 'failed', error: download.error })
  }
}

function handleDownloadControl(event) {
  const { id, action } = event.detail || {}
  const download = downloads.value.find(item => item.downloadId === id)
  if (download) control(download, action)
}

function handleDownloadEvent(event) {
  const detail = event.detail
  const download = downloads.value.find(item => item.downloadId === detail?.id)
  if (!download) return

  const native = nativeQueue().find(item => item.id === detail.id)
  Object.assign(download, mergeDownloadProgress(download, detail, native))
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
}

onMounted(() => {
  console.warn('[Downloads] view mounted')
  load()
  recoverSabrDownloads()
  try {
    const pending = JSON.parse(sessionStorage.getItem('pending-download-control') || 'null')
    if (pending) {
      sessionStorage.removeItem('pending-download-control')
      setTimeout(() => handleDownloadControl({ detail: pending }), 0)
    }
  } catch {}
  queueTimer = setInterval(load, 1000)
  window.addEventListener('android-download', handleDownloadEvent)
  window.addEventListener('android-download-control', handleDownloadControl)
})

onBeforeUnmount(async () => {
  window.removeEventListener('android-download', handleDownloadEvent)
  window.removeEventListener('android-download-control', handleDownloadControl)
  if (queueTimer) clearInterval(queueTimer)
})
</script>

<style scoped>
.downloadsView {
  max-width: 900px;
  height: calc(100dvh - 96px);
  margin: 0 auto;
  padding: 12px 24px 24px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.downloadsHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-block-end: 16px;
}

.downloadsHeader h1 {
  margin: 0;
}

.downloadsSearch input {
  width: min(360px, 45vw);
  padding: 10px 12px;
  color: var(--primary-text-color);
  background: var(--card-background-color);
  border: 1px solid var(--secondary-text-color);
  border-radius: 4px;
}

.visuallyHidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.downloadItem {
  display: flex;
  gap: 16px;
  margin: 16px 0;
  padding: 12px;
  background: var(--card-background-color);
}

.downloadThumbnail {
  width: 160px;
  height: 90px;
  object-fit: cover;
}

.downloadInfo {
  min-width: 0;
  flex: 1;
}

.downloadInfo h2 {
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}

.downloadActions {
  display: flex;
  gap: 8px;
}

@media only screen and (width <= 680px) {
  .downloadsView {
    height: calc(100dvh - 92px);
    padding: 8px;
  }

  .downloadsHeader {
    align-items: stretch;
    flex-direction: column;
  }

  .downloadsSearch input {
    width: 100%;
    box-sizing: border-box;
  }
}

</style>
