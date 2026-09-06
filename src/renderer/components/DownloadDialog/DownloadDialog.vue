<template>
  <FtPrompt
    v-if="visible"
    :label="t('Downloads.Download')"
    autosize
    @click="close"
  >
    <div class="downloadDialog">
      <div
        class="downloadModes"
        role="group"
        :aria-label="t('Downloads.Type')"
      >
        <FtButton
          :label="t('Downloads.Video')"
          :text-color="mode === 'video' ? 'var(--text-with-accent-color)' : 'var(--primary-text-color)'"
          :background-color="mode === 'video' ? 'var(--accent-color)' : 'var(--card-bg-color)'"
          @click="mode = 'video'"
        />
        <FtButton
          :label="t('Downloads.Audio')"
          :text-color="mode === 'audio' ? 'var(--text-with-accent-color)' : 'var(--primary-text-color)'"
          :background-color="mode === 'audio' ? 'var(--accent-color)' : 'var(--card-bg-color)'"
          @click="mode = 'audio'"
        />
      </div>
      <label>
        <span v-if="mode === 'video'">{{ t('Downloads.Video format') }}</span>
        <span v-else>{{ t('Downloads.Audio format') }}</span>
        <select v-model="selectedFormatId">
          <option
            v-for="format in availableFormats"
            :key="format.id"
            :value="format.id"
          >
            {{ format.label }}
          </option>
        </select>
      </label>
      <label v-if="mode === 'video' && adaptiveFormats.length > 0">
        {{ t('Downloads.Audio format') }}
        <select v-model="selectedAudioId">
          <option
            v-for="format in adaptiveFormats"
            :key="format.id"
            :value="format.id"
          >
            {{ format.label }}
          </option>
        </select>
      </label>
      <label
        v-if="captions.length > 0"
        class="subtitleToggle"
      >
        <input
          v-model="selectedCaptionIds"
          type="checkbox"
          :value="'all'"
        >
        {{ t('Downloads.Download subtitles') }}
      </label>
      <p
        v-if="selectedFormat"
        class="formatDetails"
      >
        {{ selectedFormat.label }}
        <span
          v-if="selectedFormat.size"
          class="formatSize"
        >
          {{ selectedFormat.size }}
        </span>
      </p>
      <p
        v-if="error"
        class="error"
      >
        {{ error }}
      </p>
      <div class="dialogActions">
        <FtButton
          :label="t('Downloads.Download')"
          :disabled="!selectedFormat"
          @click="submit"
        />
        <FtButton
          :label="t('Cancel')"
          @click="close"
        />
      </div>
    </div>
  </FtPrompt>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import FtButton from '../FtButton/FtButton.vue'
import FtPrompt from '../FtPrompt/FtPrompt.vue'
import { selectDownloadDirectory, validateDownloadUrls } from '../../helpers/android/downloads'
import store from '../../store'

const props = defineProps({
  visible: { type: Boolean, default: false },
  video: { type: Object, required: true },
  formats: { type: Array, default: () => [] },
  captions: { type: Array, default: () => [] },
  refreshFormats: { type: Function, default: null },
  refreshMission: { type: Object, default: null }
})

const emit = defineEmits(['close', 'queued'])
const { t } = useI18n()
const mode = ref('video')
const selectedFormatId = ref('')
const selectedAudioId = ref('')
const selectedCaptionIds = ref([])
const error = ref('')
const defaultVideoFormat = computed(() => store.getters.getDownloadsDefaultVideoFormat)
const defaultAudioFormat = computed(() => store.getters.getDownloadsDefaultAudioFormat)

const progressiveFormats = computed(() => props.formats.filter(format => format.kind === 'progressive' && format.hasVideo === (mode.value === 'video')))
const videoFormats = computed(() => props.formats.filter(format => format.kind === 'video' && format.mimeType === 'video/mp4'))
const audioFormats = computed(() => props.formats.filter(format => format.kind === 'audio'))
const availableFormats = computed(() => mode.value === 'video' ? [...progressiveFormats.value, ...videoFormats.value] : audioFormats.value)
const adaptiveFormats = computed(() => audioFormats.value.filter(format => format.mimeType === 'audio/mp4'))
const selectedFormat = computed(() => availableFormats.value.find(format => format.id === selectedFormatId.value))

watch([availableFormats, () => props.visible], () => {
  const preferred = mode.value === 'video' ? defaultVideoFormat.value : defaultAudioFormat.value
  selectedFormatId.value = availableFormats.value.find(format => {
    if (props.refreshMission?.streamSelection && matchesStreamSelection(format, props.refreshMission.streamSelection)) return true
    if (preferred === 'auto') return false
    const preferredMime = preferred === 'm4a' ? 'audio/mp4' : preferred
    return format.mimeType === preferredMime || format.container === preferred
  })?.id ?? availableFormats.value[0]?.id ?? ''
  const refreshAudio = props.refreshMission?.parts?.find(part => part.kind === 'audio')
  selectedAudioId.value = adaptiveFormats.value.find(format => refreshAudio && matchesStreamSelection(format, refreshAudio))?.id ?? adaptiveFormats.value[0]?.id ?? ''
  selectedCaptionIds.value = []
  error.value = ''
}, { immediate: true })

function close() {
  emit('close')
}

function matchesStreamSelection(format, target) {
  if (!target) return false
  if (format.kind !== target.kind || format.mimeType !== target.mimeType) return false
  if (target.height && format.height) return target.height === format.height
  if (target.quality && format.quality) return target.quality === format.quality
  return !target.bitrate || !format.bitrate || target.bitrate === format.bitrate
}

async function enqueueCandidates(formats, audios, directoryUri) {
  let error
  for (const format of formats) {
    if (mode.value === 'video' && format.kind === 'video' && audios.length === 0) continue
    const audioCandidates = mode.value === 'video' && format.kind === 'video' ? audios : [null]
    for (const audio of audioCandidates) {
      const parts = [{ ...format }]
      if (audio) parts.push({ ...audio })
      const extension = extensionFor(format.mimeType)
      const suffix = mode.value === 'audio' ? ' - audio' : ''
      const request = {
        video: props.video,
        kind: mode.value,
        parts,
        url: parts[0].url,
        sourceUrl: `https://www.youtube.com/watch?v=${props.video.id}`,
        streamSelection: {
          id: format.id,
          kind: format.kind,
          mimeType: format.mimeType,
          quality: format.quality,
          width: format.width,
          height: format.height,
          bitrate: format.bitrate
        },
        mimeType: format.mimeType,
        extension,
        fileName: `${sanitize(props.video.title)}${suffix}.${extension}`,
        directoryUri
      }
      console.warn('[Downloads] Validate candidate ' + JSON.stringify({
        videoId: props.video.id,
        partIds: parts.map(part => part.id),
        kind: format.kind,
        mimeType: format.mimeType,
        quality: format.quality,
        width: format.width,
        height: format.height,
        bitrate: format.bitrate
      }))
      const validation = validateDownloadUrls(request)
      console.warn('[Downloads] Candidate validation ' + JSON.stringify({
        partIds: parts.map(part => part.id),
        ok: validation.ok,
        error: validation.error || null
      }))
      if (!validation.ok) {
        error = new Error(validation.error)
        continue
      }
      if (props.refreshMission) {
        const refreshed = await store.dispatch('refreshDownload', { id: props.refreshMission.id, request })
        if (refreshed) return { id: props.refreshMission.id, error: null }
        error = new Error('No matching replacement stream found')
      } else {
        return { id: await store.dispatch('enqueueDownload', request), error: null }
      }
    }
  }
  return { id: null, error }
}

async function submit() {
  if (!selectedFormat.value) return
  error.value = ''
  try {
    const directoryUri = props.refreshMission?.directoryUri || await selectDownloadDirectory()
    if (!directoryUri) return

    const selectedAudio = audioFormats.value.find(format => format.id === selectedAudioId.value)
    if (mode.value === 'video' && availableFormats.value.some(format => format.kind === 'video') && !selectedAudio) {
      throw new Error(t('Downloads.Audio format is not available'))
    }

    const enqueueResult = await enqueueCandidates(
      props.refreshMission
        ? [selectedFormat.value]
        : [selectedFormat.value, ...availableFormats.value.filter(format => format.id !== selectedFormat.value.id)],
      props.refreshMission ? [selectedAudio] : (selectedAudio ? [selectedAudio] : []),
      directoryUri
    )
    let videoMissionId = enqueueResult.id
    if (!videoMissionId && props.refreshFormats) {
      const refreshedFormats = await props.refreshFormats()
      console.warn('[Downloads] Refreshed candidate count ' + JSON.stringify({ total: refreshedFormats.length, mode: mode.value }))
      const refreshedAvailable = refreshedFormats.filter(format => {
        const available = mode.value === 'video'
          ? (format.kind === 'progressive' && format.hasVideo) || (format.kind === 'video' && format.mimeType === 'video/mp4')
          : format.kind === 'audio'
        return available && matchesStreamSelection(format, selectedFormat.value)
      })
      const refreshedAudio = refreshedFormats.find(format => format.kind === 'audio' && format.mimeType === 'audio/mp4' && matchesStreamSelection(format, selectedAudio))
      const refreshedAudios = refreshedAudio ? [refreshedAudio] : []
      const refreshedResult = await enqueueCandidates(refreshedAvailable, refreshedAudios, directoryUri)
      videoMissionId = refreshedResult.id
      if (!videoMissionId) enqueueResult.error = refreshedResult.error
    }
    if (!videoMissionId) throw enqueueResult.error || new Error('No downloadable stream found')

    if (!props.refreshMission && mode.value === 'video' && selectedCaptionIds.value.length > 0) {
      for (const caption of props.captions) {
        try {
          const language = sanitize(caption.language || 'und')
          await store.dispatch('enqueueDownload', {
            video: props.video,
            kind: 'subtitle',
            parentId: videoMissionId,
            parts: [{ ...caption, kind: 'subtitle', extension: 'vtt' }],
            url: caption.url,
            mimeType: 'text/vtt',
            extension: 'vtt',
            fileName: `${sanitize(props.video.title)}.${language}.vtt`,
            directoryUri
          })
        } catch (subtitleException) {
          error.value = subtitleException.message
        }
      }
    }
    emit('queued')
    close()
  } catch (exception) {
    error.value = exception.message
  }
}

function extensionFor(mimeType = '') {
  return { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/webm': 'webm' }[mimeType] || 'bin'
}

function sanitize(value = '') {
  return [...value]
    .map(character => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
    .replaceAll(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 180) || props.video.id
}
</script>

<style scoped>
.downloadDialog { display: flex; flex-direction: column; gap: 1rem; min-width: min(30rem, 80vw); }
.downloadModes, .dialogActions { display: flex; gap: .5rem; flex-wrap: wrap; }
.downloadDialog label { display: flex; flex-direction: column; gap: .35rem; text-align: start; }
.downloadDialog .subtitleToggle { flex-direction: row; align-items: center; }
.downloadDialog select { padding: .5rem; color: var(--text-color); background: var(--card-bg-color); }
.formatDetails { margin: 0; text-align: start; }
.formatSize::before { content: ' '; }
.error { color: var(--destructive-color); margin: 0; }
</style>
