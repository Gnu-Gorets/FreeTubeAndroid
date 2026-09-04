<template>
  <section class="downloadsView">
    <div class="downloadsHeader">
      <h1>{{ t('Downloads.Title') }}</h1>
      <div class="downloadBulkActions">
        <button
          type="button"
          data-download-action="select-all"
          @click="selectAll"
        >
          {{ selectAllLabel }}
        </button>
        <button
          v-if="selectedDownloadIds.size"
          type="button"
          data-download-action="delete-selected"
          @click="removeMany()"
        >
          {{ t('Downloads.Delete') }} {{ selectedDownloadIds.size }}
        </button>
      </div>
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
      :data-download-id="download.downloadId"
    >
      <input
        class="downloadSelect"
        type="checkbox"
        :checked="selectedDownloadIds.has(download.downloadId)"
        :aria-label="download.title"
        @change="toggleSelected(download.downloadId)"
      >
      <img
        :src="download.thumbnail || ''"
        alt=""
        class="downloadThumbnail"
      >
      <div class="downloadInfo">
        <h2>{{ download.title }}</h2>
        <p class="downloadMeta">
          {{ formatDownloadMeta(download) }}
        </p>
        <progress
          v-if="download.status === 'downloading' && download.received > 0 && download.total > 0"
          max="1"
          :value="download.progress"
          :aria-label="t('Downloads.Progress')"
        />
        <div class="downloadActions">
          <button
            v-if="download.status === 'completed'"
            type="button"
            data-download-action="play"
            @click="play(download)"
          >
            {{ t('Downloads.Play') }}
          </button>
          <button
            v-if="download.status === 'failed'"
            type="button"
            data-download-action="retry"
            @click="retry(download)"
          >
            {{ t('Downloads.Retry') }}
          </button>
          <button
            v-if="download.status === 'downloading'"
            type="button"
            data-download-action="pause"
            @click="control(download, 'pause')"
          >
            {{ t('Downloads.Pause') }}
          </button>
          <button
            v-if="download.status === 'paused'"
            type="button"
            data-download-action="resume"
            @click="control(download, 'resume')"
          >
            {{ t('Downloads.Resume') }}
          </button>
          <button
            v-if="['queued', 'downloading', 'paused'].includes(download.status)"
            type="button"
            data-download-action="cancel"
            @click="control(download, 'cancel')"
          >
            {{ t('Downloads.Cancel') }}
          </button>
          <button
            type="button"
            data-download-action="delete"
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
import { awaitAsyncResult } from '../../helpers/android/jsinterface'
import { cancelSabrDownload, hasSabrDownload, isSabrDownloadCanceled, isSabrDownloadPaused, mergeDownloadProgress, mergeNativeDownload, pauseSabrDownload, recoverSabrDownload, updateDownloadMetadata } from '../../helpers/android/downloads'
import { filterDownloads } from '../../helpers/android/download-search.mjs'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const router = useRouter()
const downloads = ref([])
const searchQuery = ref('')
const selectedDownloadIds = ref(new Set())
const selectAllLabel = computed(() => {
  if (selectedDownloadIds.value.size === downloads.value.length) return t('Downloads.Select None')
  return t('Downloads.Select all')
})
const filteredDownloads = computed(() => filterDownloads(downloads.value, searchQuery.value))
let queueTimer = null
let sabrRecoveryRunning = false

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function formatProgress(download) {
  const percent = download.progress == null ? '—' : `${Math.round(download.progress * 100)}%`
  const bytes = `${formatBytes(download.received)}/${download.totalExact === false ? '~' : ''}${formatBytes(download.total)}`
  const format = download.selectedFormat?.replace(/\s+\(.+\)$/, '') || ''
  return `${percent} · ${bytes}${format ? ` · ${format}` : ''} · ${formatSpeed(download.speedBps || 0)}`
}

function formatDownloadMeta(download) {
  const parts = [download.status]
  const hasProgress = download.status === 'downloading' && download.received > 0 && download.total > 0
  if (hasProgress) return formatProgress(download)
  if (download.status === 'completed') {
    const size = download.fileSize || download.received || download.total
    if (size > 0) parts.push(formatBytes(size))
  }
  if (download.selectedFormat) parts.push(download.selectedFormat)
  return parts.join(' · ')
}

function formatSpeed(value) {
  return `${(value / 1024 ** 2).toFixed(1)} MB/s`
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
    downloads.value = stored.flatMap(download => {
      const native = queue.find(item => item.id === download.downloadId)
      if (native) return [mergeNativeDownload(download, native)]
      if (download.status === 'completed' && download.localPath && window.Android?.fileExists && !window.Android.fileExists(download.localPath)) return []
      return [download.status === 'downloading' && !download.interrupted && !hasSabrDownload(download.downloadId)
        ? { ...download, status: 'queued', interrupted: true, error: 'Download interrupted' }
        : download]
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
    if (/HTTP 403/.test(download.error || '')) {
      console.warn('[Downloads] stale URL retry requires fresh formats', { id: download.downloadId })
      router.push(`/watch/${download.videoId}`)
    } else {
      control(download, 'retry')
    }
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

async function control(download, action) {
  if (download.manifestSrc) {
    if (action === 'cancel' || action === 'pause') {
      if (!hasSabrDownload(download.downloadId)) return
      if (action === 'pause') pauseSabrDownload(download.downloadId)
      else cancelSabrDownload(download.downloadId)
      download.status = action === 'pause' ? 'paused' : 'canceled'
      updateDownloadMetadata(download.downloadId, { status: download.status, interrupted: action === 'pause', error: null })
      if (action === 'pause') {
        android.updateDownloadNotification?.(download.downloadId, download.title, 'paused', Math.round((download.progress || 0) * 100), download.speedBps || 0, download.received || 0, download.total || 0)
      } else {
        android.finishDownloadNotification?.(download.downloadId)
      }
    } else if (action === 'resume' || action === 'retry') {
      while (hasSabrDownload(download.downloadId)) await new Promise(resolve => setTimeout(resolve, 50))
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

function toggleSelected(id) {
  const next = new Set(selectedDownloadIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedDownloadIds.value = next
}

function selectAll() {
  selectedDownloadIds.value = selectedDownloadIds.value.size === downloads.value.length
    ? new Set()
    : new Set(downloads.value.map(download => download.downloadId))
}

async function removeMany(items = downloads.value.filter(download => selectedDownloadIds.value.has(download.downloadId))) {
  items = [...items]
  if (!items.length) return
  const active = items.filter(download => ['queued', 'downloading', 'paused'].includes(download.status))
  active.forEach(download => control(download, 'cancel'))
  if (active.some(download => !download.manifestSrc)) await new Promise(resolve => setTimeout(resolve, 300))

  const player = items.some(download => download.offlineUri) ? new shaka.Player(document.createElement('video')) : null
  const storage = player ? new shaka.offline.Storage(player) : null
  try {
    const stored = storage ? await storage.list() : []
    const results = []
    for (const download of items) {
      try {
        if (download.localPath && window.Android?.deleteDownloadFile) await awaitAsyncResult(android.deleteDownloadFile(download.localPath))
        const content = stored.find(item => item.offlineUri === download.offlineUri)
        if (content) await storage.remove(content.offlineUri)
        results.push({ id: download.downloadId, ok: true })
      } catch (error) {
        console.error('[Downloads] unable to delete download', { id: download.downloadId, error })
        results.push({ id: download.downloadId, ok: false })
      }
    }
    const deleted = new Set(results.filter(result => result.ok).map(result => result.id))
    downloads.value = downloads.value.filter(download => !deleted.has(download.downloadId))
    selectedDownloadIds.value = new Set([...selectedDownloadIds.value].filter(id => !deleted.has(id)))
    localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  } finally {
    await storage?.destroy()
    await player?.destroy()
  }
}

async function remove(download) {
  await removeMany([download])
}

async function recoverSabrDownloads() {
  if (sabrRecoveryRunning) return
  sabrRecoveryRunning = true
  try {
    let download
    while ((download = downloads.value.find(item => item.status === 'queued' && item.interrupted && item.manifestSrc && item.sabrData))) {
      const progress = download.total > 0 ? 0 : null
      Object.assign(download, { status: 'downloading', progress, received: 0, speedBps: 0, etaSeconds: 0 })
      updateDownloadMetadata(download.downloadId, { status: 'downloading', progress, received: 0, speedBps: 0, etaSeconds: 0 })
      try {
        const recovered = await recoverSabrDownload(download, (content, progress, total, totalExact) => {
          if (isSabrDownloadPaused(download.downloadId) || isSabrDownloadCanceled(download.downloadId)) return
          Object.assign(download, { progress, received: content?.size || 0, total: total || 0, totalExact })
          updateDownloadMetadata(download.downloadId, { status: 'downloading', progress, received: download.received, total: download.total, totalExact })
        })
        Object.assign(download, recovered, { status: 'completed', phase: 'completed', interrupted: false })
        updateDownloadMetadata(download.downloadId, {
          phase: 'completed',
          status: 'completed',
          progress: download.progress,
          received: download.received,
          total: download.total,
          totalExact: download.totalExact,
          offlineUri: download.offlineUri,
          localPath: download.localPath,
          fileName: download.fileName,
          error: null,
          completedAt: Date.now(),
          interrupted: false
        })
      } catch (error) {
        if (isSabrDownloadPaused(download.downloadId)) {
          Object.assign(download, { status: 'paused', error: null })
          updateDownloadMetadata(download.downloadId, { status: 'paused', interrupted: true, error: null })
        } else if (isSabrDownloadCanceled(download.downloadId)) {
          Object.assign(download, { status: 'canceled', error: null })
          updateDownloadMetadata(download.downloadId, { status: 'canceled', error: null })
        } else {
          Object.assign(download, { status: 'failed', error: error.message || 'SABR recovery failed' })
          updateDownloadMetadata(download.downloadId, { status: 'failed', error: download.error })
        }
      }
    }
  } finally {
    sabrRecoveryRunning = false
  }
}

function handleDownloadControl(event) {
  const { id, action } = event.detail || {}
  const download = downloads.value.find(item => item.downloadId === id)
  if (download) control(download, action)
}

function installTestHook() {
  if (!window.Android?.isDebugBuild?.()) return
  const offlineContents = async () => {
    const player = new shaka.Player(document.createElement('video'))
    const storage = new shaka.offline.Storage(player)
    try {
      return (await storage.list()).map(content => content.offlineUri).sort()
    } finally {
      await storage.destroy()
      await player.destroy()
    }
  }
  window.__ftTest = {
    downloads: () => downloads.value.map(({ downloadId, videoId, status, selectedFormat, received, total, totalExact, fileSize, offlineUri, createdAt }) => ({ id: downloadId, videoId, status, selectedFormat, received, total, totalExact, fileSize, offlineUri, createdAt })),
    active: id => hasSabrDownload(id),
    offlineContents,
    removeOffline: async uri => {
      const player = new shaka.Player(document.createElement('video'))
      const storage = new shaka.offline.Storage(player)
      try {
        if ((await storage.list()).some(content => content.offlineUri === uri)) await storage.remove(uri)
      } finally {
        await storage.destroy()
        await player.destroy()
      }
    },
    control: (id, action) => {
      const download = downloads.value.find(item => item.downloadId === id)
      if (!download) return false
      control(download, action)
      return true
    },
    remove: async id => {
      const download = downloads.value.find(item => item.downloadId === id)
      if (!download) return false
      await remove(download)
      return true
    },
    clearQueue: async () => {
      for (const download of [...downloads.value]) await remove(download)
      return true
    }
  }
}

function handleDownloadEvent(event) {
  const detail = event.detail
  const download = downloads.value.find(item => item.downloadId === detail?.id)
  if (!download) return

  const native = nativeQueue().find(item => item.id === detail.id)
  const changes = Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined))
  Object.assign(download, mergeDownloadProgress(download, changes, native))
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
}

onMounted(() => {
  console.warn('[Downloads] view mounted')
  load()
  installTestHook()
  recoverSabrDownloads()
  try {
    const pending = JSON.parse(sessionStorage.getItem('pending-download-control') || 'null')
    if (pending) {
      sessionStorage.removeItem('pending-download-control')
      setTimeout(() => handleDownloadControl({ detail: pending }), 0)
    }
  } catch {}
  queueTimer = setInterval(load, 3000)
  window.addEventListener('android-download', handleDownloadEvent)
  window.addEventListener('android-download-control', handleDownloadControl)
  window.addEventListener('app-resume', load)
})

onBeforeUnmount(async () => {
  window.removeEventListener('android-download', handleDownloadEvent)
  window.removeEventListener('android-download-control', handleDownloadControl)
  window.removeEventListener('app-resume', load)
  delete window.__ftTest
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
  display: grid;
  grid-template-columns: 24px 160px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  margin: 16px 0;
  padding: 12px;
  background: var(--card-background-color);
  border: 1px solid var(--secondary-text-color);
  border-radius: 6px;
}

.downloadSelect {
  inline-size: 20px;
  block-size: 20px;
  margin-block-start: 2px;
}

.downloadThumbnail {
  display: block;
  inline-size: 160px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 4px;
}

.downloadInfo {
  min-inline-size: 0;
}

.downloadInfo h2 {
  display: -webkit-box;
  margin: 0 0 6px;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.downloadMeta {
  min-inline-size: 0;
  margin: 0 0 10px;
  overflow: hidden;
  font-size: 0.9rem;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.downloadInfo progress {
  display: block;
  inline-size: 100%;
  margin-block-end: 10px;
}

.downloadActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.downloadActions button,
.downloadBulkActions button {
  min-block-size: 40px;
  padding: 8px 14px;
  color: var(--primary-text-color);
  font: inherit;
  background: var(--card-background-color);
  border: 1px solid var(--secondary-text-color);
  border-radius: 4px;
  cursor: pointer;
}

.downloadActions button:hover,
.downloadBulkActions button:hover {
  background: var(--secondary-text-color);
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

  .downloadItem {
    grid-template-columns: 24px 112px minmax(0, 1fr);
    gap: 10px;
    padding: 10px;
  }

  .downloadThumbnail {
    inline-size: 112px;
  }

  .downloadInfo {
    min-inline-size: 0;
  }

  .downloadBulkActions {
    display: flex;
    gap: 8px;
  }

  .downloadBulkActions button {
    flex: 1;
  }
}

</style>
