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
      :key="download.localPath"
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
        <div class="downloadActions">
          <button
            v-if="download.status === 'completed'"
            type="button"
            @click="play(download)"
          >
            {{ t('Downloads.Play') }}
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
      v-if="playingUrl"
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
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const downloads = ref([])
const playingUrl = ref(null)

function load() {
  try {
    downloads.value = JSON.parse(localStorage.getItem('freetube-downloads') || '[]')
  } catch (error) {
    console.error('Unable to load downloads metadata', error)
    downloads.value = []
  }
}

function play(download) {
  if (typeof window.Android?.getLocalPlaybackUrl !== 'function') return
  playingUrl.value = window.Android.getLocalPlaybackUrl(download.localPath)
}

function remove(download) {
  window.Android?.deleteFile(download.localPath)
  downloads.value = downloads.value.filter(item => item.localPath !== download.localPath)
  localStorage.setItem('freetube-downloads', JSON.stringify(downloads.value))
  if (playingUrl.value?.includes(encodeURIComponent(download.localPath))) playingUrl.value = null
}

onMounted(() => {
  load()
  window.addEventListener('android-download', load)
})

onBeforeUnmount(() => window.removeEventListener('android-download', load))
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
