<template>
  <section class="downloadsView">
    <h1>{{ t('Downloads.Title') }}</h1>
    <p
      v-if="downloads.length === 0"
    >
      {{ t('Downloads.Empty') }}
    </p>
    <article
      v-for="download in downloads"
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
    <div
      v-if="playingUrl || playingOffline"
      class="downloadPlayerOverlay"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Downloads.Player')"
      @click.self="closePlayer"
      @keydown.esc="closePlayer"
    >
      <button
        type="button"
        class="downloadPlayerClose"
        :aria-label="t('Downloads.Close player')"
        @click="closePlayer"
      >
        {{ t('Downloads.Close player') }}
      </button>
      <!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
      <video
        ref="video"
        class="downloadPlayer"
        controls
        autoplay
        playsinline
        :src="playingUrl"
        @error="playingUrl = null"
        @ended="playNext"
      />
    </div>
  </section>
</template>

<script setup>
import shaka from 'shaka-player'
import { hasSabrDownload, recoverSabrDownload, updateDownloadMetadata } from '../../helpers/android/downloads'
import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const router = useRouter()
const downloads = ref([])
const playingUrl = ref(null)
const playingOffline = ref(null)
const video = useTemplateRef('video')
let player = null
let queueTimer = null

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
    downloads.value = JSON.parse(localStorage.getItem('freetube-downloads') || '[]').map(download => {
      const native = queue.find(item => item.id === download.downloadId)
      if (native) return { ...download, status: native.status, progress: native.progress, error: native.error }
      return download.status === 'downloading' && !download.interrupted && !hasSabrDownload(download.downloadId)
        ? { ...download, status: 'queued', interrupted: true, error: 'Download interrupted' }
        : download
    })
    localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  } catch (error) {
    console.error('Unable to load downloads metadata', error)
    downloads.value = []
  }
}

async function stopPlayer() {
  if (!player) return
  await player.destroy()
  player = null
}

async function retry(download) {
  if (nativeQueue().some(item => item.id === download.downloadId)) {
    control(download, 'retry')
    return
  }
  router.push(`/watch/${download.videoId}`)
}

function control(download, action) {
  window.Android?.controlNativeDownload?.(action, download.downloadId)
  setTimeout(load, 100)
}

async function play(download) {
  await stopPlayer()
  if (download.offlineUri) {
    playingUrl.value = null
    playingOffline.value = download
    await nextTick()
    player = new shaka.Player(video.value)
    await player.load(download.offlineUri)
    return
  }
  if (typeof window.Android?.getLocalPlaybackUrl !== 'function') return
  playingOffline.value = null
  playingUrl.value = window.Android.getLocalPlaybackUrl(download.localPath)
}

async function closePlayer() {
  await stopPlayer()
  playingOffline.value = null
  playingUrl.value = null
}

async function playNext() {
  const current = playingOffline.value || downloads.value.find(download => playingUrl.value?.includes(encodeURIComponent(download.localPath)))
  const index = downloads.value.indexOf(current)
  const next = downloads.value.slice(index + 1).find(download => download.status === 'completed')
  if (next) await play(next)
}

async function remove(download) {
  if (download.offlineUri) {
    const storage = new shaka.offline.Storage()
    await storage.remove(download.offlineUri)
    await storage.destroy()
  } else {
    window.Android?.deleteFile(download.localPath)
  }
  if (['queued', 'downloading', 'paused'].includes(download.status)) control(download, 'cancel')
  downloads.value = downloads.value.filter(item => download.offlineUri
    ? item.offlineUri !== download.offlineUri
    : item.localPath !== download.localPath)
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  if (playingOffline.value === download || playingUrl.value?.includes(encodeURIComponent(download.localPath))) {
    await stopPlayer()
    playingOffline.value = null
    playingUrl.value = null
  }
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
    download.status = 'failed'
    download.error = error.message || 'SABR recovery failed'
    updateDownloadMetadata(download.downloadId, { status: 'failed', error: download.error })
  }
}

function handleDownloadEvent(event) {
  const download = downloads.value.find(item => item.downloadId === event.detail?.id)
  if (download && event.detail.status === 'downloading') {
    download.progress = event.detail.progress ?? (event.detail.total > 0 ? event.detail.received / event.detail.total : null)
    localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  }
  load()
}

function handleEscape(event) {
  if (event.key === 'Escape') closePlayer()
}

onMounted(() => {
  load()
  recoverSabrDownloads()
  window.addEventListener('keydown', handleEscape)
  queueTimer = setInterval(load, 1000)
  window.addEventListener('android-download', handleDownloadEvent)
})

onBeforeUnmount(async () => {
  window.removeEventListener('android-download', handleDownloadEvent)
  window.removeEventListener('keydown', handleEscape)
  if (queueTimer) clearInterval(queueTimer)
  await stopPlayer()
})
</script>

<style scoped>
.downloadsView {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
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

.downloadPlayerOverlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 80%);
}

.downloadPlayerClose {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: rgb(0 0 0 / 70%);
  font-size: 0;
  line-height: 1;
  cursor: pointer;
}

.downloadPlayerClose::before,
.downloadPlayerClose::after {
  position: absolute;
  top: 21px;
  left: 11px;
  width: 22px;
  height: 2px;
  background: currentColor;
  content: '';
  font-size: 32px;
}

.downloadPlayerClose::before {
  transform: rotate(45deg);
}

.downloadPlayerClose::after {
  transform: rotate(-45deg);
}

.downloadPlayer {
  width: min(100%, 1100px);
  max-height: calc(100vh - 48px);
  aspect-ratio: 16 / 9;
  background: #000;
}
</style>
