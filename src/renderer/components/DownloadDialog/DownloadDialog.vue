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
          :background-color="mode === 'video' ? 'var(--accent-color)' : null"
          @click="mode = 'video'"
        />
        <FtButton
          :label="t('Downloads.Audio')"
          :background-color="mode === 'audio' ? 'var(--accent-color)' : null"
          @click="mode = 'audio'"
        />
      </div>
      <label>
        {{ t('Downloads.Format') }}
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
      <label v-if="captions.length > 0">
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
import { selectDownloadDirectory } from '../../helpers/android/downloads'
import store from '../../store'

const props = defineProps({
  visible: { type: Boolean, default: false },
  video: { type: Object, required: true },
  formats: { type: Array, default: () => [] },
  captions: { type: Array, default: () => [] }
})

const emit = defineEmits(['close', 'queued'])
const { t } = useI18n()
const mode = ref('video')
const selectedFormatId = ref('')
const selectedAudioId = ref('')
const selectedCaptionIds = ref([])
const error = ref('')

const progressiveFormats = computed(() => props.formats.filter(format => format.kind === 'progressive' && format.hasVideo === (mode.value === 'video')))
const videoFormats = computed(() => props.formats.filter(format => format.kind === 'video'))
const audioFormats = computed(() => props.formats.filter(format => format.kind === 'audio'))
const availableFormats = computed(() => mode.value === 'video' ? [...progressiveFormats.value, ...videoFormats.value] : audioFormats.value)
const adaptiveFormats = computed(() => audioFormats.value)
const selectedFormat = computed(() => availableFormats.value.find(format => format.id === selectedFormatId.value))

watch([availableFormats, () => props.visible], () => {
  selectedFormatId.value = availableFormats.value[0]?.id ?? ''
  selectedAudioId.value = adaptiveFormats.value[0]?.id ?? ''
  selectedCaptionIds.value = []
  error.value = ''
}, { immediate: true })

function close() {
  emit('close')
}

async function submit() {
  if (!selectedFormat.value) return
  error.value = ''
  try {
    const format = selectedFormat.value
    const parts = [{ ...format }]
    if (mode.value === 'video' && format.kind === 'video') {
      const audio = audioFormats.value.find(item => item.id === selectedAudioId.value)
      if (!audio) throw new Error(t('Downloads.Audio format is not available'))
      parts.push({ ...audio })
    }
    const directoryUri = await selectDownloadDirectory()
    if (!directoryUri) return
    const extension = extensionFor(format.mimeType)
    const suffix = mode.value === 'audio' ? ' - audio' : ''
    const fileName = `${sanitize(props.video.title)}${suffix}.${extension}`
    const request = {
      video: props.video,
      kind: mode.value,
      parts,
      url: parts[0].url,
      mimeType: format.mimeType,
      extension,
      fileName,
      directoryUri,
      captions: selectedCaptionIds.value.length > 0 ? props.captions : []
    }
    await store.dispatch('enqueueDownload', request)
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
.downloadDialog select { padding: .5rem; color: var(--text-color); background: var(--card-bg-color); }
.formatDetails { margin: 0; text-align: start; }
.formatSize::before { content: ' '; }
.error { color: var(--destructive-color); margin: 0; }
</style>
