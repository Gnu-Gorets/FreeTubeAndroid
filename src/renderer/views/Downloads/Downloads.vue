<template>
  <div
    class="downloadsView"
  >
    <FtCard>
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'download']"
          class="headingIcon"
          aria-hidden="true"
        />
        {{ t('Downloads.Downloads') }}
      </h2>
      <FtButton
        v-if="completedVideos.length > 0"
        :label="t('Downloads.Play all')"
        @click="playAll"
      />
      <p
        v-if="missions.length === 0"
        class="message"
      >
        {{ t('Downloads.Empty') }}
      </p>
      <template v-else>
        <section
          v-for="section in sections"
          v-show="section.items.length > 0"
          :key="section.status"
          class="downloadSection"
          :aria-labelledby="`downloads-${section.status}`"
        >
          <h3 :id="`downloads-${section.status}`">
            {{ section.label }}
          </h3>
          <div
            v-for="mission in section.items"
            :key="mission.id"
            class="mission"
          >
            <img
              v-if="mission.video?.thumbnail"
              :src="mission.video.thumbnail"
              :alt="mission.video?.title || mission.title"
              class="thumbnail"
            >
            <div
              class="missionInfo"
            >
              <strong dir="auto">{{ mission.video?.title || mission.title }}</strong>
              <span>{{ t('Downloads.Type') }}{{ t('Downloads.LabelSeparator') }} {{ mission.kind }}</span>
              <span>{{ t('Downloads.Format') }}{{ t('Downloads.LabelSeparator') }} {{ mission.mimeType }}</span>
              <span>{{ mission.fileName }}</span>
              <span v-if="isProgress(mission)">
                {{ formatBytes(mission.downloadedBytes) }} / {{ formatBytes(mission.totalBytes) }}
                <span v-if="mission.status === 'downloading' && mission.speedBytesPerSecond">
                  {{ t('Downloads.LabelSeparator') }} {{ formatBytes(mission.speedBytesPerSecond) }}{{ t('Downloads.PerSecond') }}
                </span>
                <span v-if="mission.status === 'downloading' && mission.etaSeconds !== undefined">
                  {{ t('Downloads.LabelSeparator') }} {{ t('Downloads.ETA') }}{{ t('Downloads.LabelSeparator') }} {{ formatDuration(mission.etaSeconds) }}
                </span>
              </span>
              <span
                v-if="mission.error"
                class="error"
              >
                {{ mission.error }}
              </span>
            </div>
            <div class="missionActions">
              <FtButton
                v-if="mission.status === 'queued' || mission.status === 'downloading'"
                :label="t('Downloads.Pause')"
                @click="run('pauseDownload', mission.id)"
              />
              <FtButton
                v-if="mission.status === 'paused'"
                :label="t('Downloads.Resume')"
                @click="run('resumeDownload', mission.id)"
              />
              <FtButton
                v-if="isProgress(mission)"
                :label="t('Downloads.Cancel')"
                @click="run('cancelDownload', mission.id)"
              />
              <FtButton
                v-if="mission.status === 'failed' && mission.needsRefresh && mission.video?.id"
                :label="t('Downloads.Retry')"
                @click="refresh(mission)"
              />
              <FtButton
                v-else-if="mission.status === 'failed'"
                :label="t('Downloads.Retry')"
                @click="run('retryDownload', mission.id)"
              />
              <FtButton
                v-if="mission.status === 'completed' && mission.outputUri"
                :label="t('Downloads.Open')"
                @click="open(mission.outputUri, mission.mimeType)"
              />
              <FtButton
                v-if="mission.status === 'completed' && mission.outputUri"
                :label="t('Downloads.Share')"
                @click="share(mission.outputUri, mission.mimeType)"
              />
              <FtButton
                v-if="mission.video?.id"
                :label="t('Downloads.Source')"
                @click="router.push(`/watch/${mission.video.id}`)"
              />
              <FtButton
                :label="t('Downloads.Delete')"
                @click="run('deleteDownload', mission.id)"
              />
            </div>
          </div>
        </section>
      </template>
    </FtCard>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import store from '../../store'
import { formatDurationAsTimestamp, openExternalLink } from '../../helpers/utils'
import { openDownload, shareDownload } from '../../helpers/android/downloads'

const { t } = useI18n()
const router = useRouter()
const missions = computed(() => store.getters.getDownloadMissions)
const completedVideos = computed(() => missions.value.filter(mission => mission.status === 'completed' && mission.kind === 'video' && mission.video?.id && mission.outputUri))

const sections = computed(() => [
  { status: 'active', label: t('Downloads.Active'), items: missions.value.filter(mission => ['queued', 'downloading'].includes(mission.status)) },
  { status: 'post-processing', label: t('Downloads.Post processing'), items: missions.value.filter(mission => mission.status === 'post-processing') },
  { status: 'paused', label: t('Downloads.Paused'), items: missions.value.filter(mission => mission.status === 'paused') },
  { status: 'completed', label: t('Downloads.Completed'), items: missions.value.filter(mission => mission.status === 'completed') },
  { status: 'failed', label: t('Downloads.Failed'), items: missions.value.filter(mission => mission.status === 'failed') },
  { status: 'canceled', label: t('Downloads.Canceled'), items: missions.value.filter(mission => mission.status === 'canceled') },
  { status: 'missing', label: t('Downloads.Missing'), items: missions.value.filter(mission => mission.status === 'missing') }
])

onMounted(() => {
  store.dispatch('startDownloadUpdates')
  store.dispatch('grabDownloads')
})

function isProgress(mission) {
  return ['queued', 'downloading', 'paused', 'post-processing'].includes(mission.status)
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = value
  let unit = 'B'
  for (const nextUnit of units) {
    amount /= 1024
    unit = nextUnit
    if (amount < 1024 || nextUnit === units.at(-1)) break
  }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${unit}`
}

function run(action, id) {
  store.dispatch(action, id)
}

function refresh(mission) {
  router.push({
    path: `/watch/${mission.video.id}`,
    query: { refreshDownloadId: mission.id }
  })
}

function playAll() {
  const first = [...completedVideos.value].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0]
  if (!first) return
  router.push({
    path: `/watch/${first.video.id}`,
    query: { playlistId: 'downloads', playlistType: 'downloaded' }
  })
}

function open(uri, mimeType) {
  if (!openDownload(uri, mimeType)) openExternalLink(uri)
}

function share(uri, mimeType) {
  shareDownload(uri, mimeType)
}

function formatDuration(seconds) {
  return formatDurationAsTimestamp(seconds)
}
</script>

<style scoped>
.downloadsView { width: 100%; }
.headingIcon { margin-inline-end: .5rem; }
.message { text-align: center; }
.downloadSection { margin-block: 1.5rem; }
.mission { display: flex; justify-content: space-between; gap: 1rem; padding: 1rem 0; border-block-start: 1px solid var(--card-border-color); }
.thumbnail { width: 120px; height: 68px; object-fit: cover; flex: 0 0 auto; }
.missionInfo { display: flex; flex-direction: column; gap: .25rem; min-width: 0; text-align: start; }
.missionInfo strong { overflow-wrap: anywhere; }
.missionActions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: .5rem; }
.error { color: var(--destructive-color); }
@media (max-width: 600px) { .mission { flex-direction: column; } .missionActions { justify-content: flex-start; } }
</style>
