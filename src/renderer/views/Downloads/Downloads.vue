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
    <!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
    <video
      v-if="playingUrl || playingOffline"
      ref="video"
      class="downloadPlayer"
      controls
      autoplay
      playsinline
      :src="playingUrl"
      @error="playingUrl = null"
    />
  </section>
</template>

<script setup>
import shaka from 'shaka-player'
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
      return download.status === 'downloading'
        ? { ...download, status: 'failed', error: 'Download interrupted' }
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

function handleDownloadEvent(event) {
  const download = downloads.value.find(item => item.downloadId === event.detail?.id)
  if (download && event.detail.status === 'downloading') {
    download.progress = event.detail.progress ?? (event.detail.total > 0 ? event.detail.received / event.detail.total : null)
    localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  }
  load()
}

onMounted(() => {
  load()
  queueTimer = setInterval(load, 1000)
  window.addEventListener('android-download', handleDownloadEvent)
})

onBeforeUnmount(async () => {
  window.removeEventListener('android-download', handleDownloadEvent)
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

.downloadPlayer {
  width: 100%;
  margin-top: 24px;
}
</style>
