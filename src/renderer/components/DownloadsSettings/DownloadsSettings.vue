<template>
  <FtSettingsSection :title="t('Downloads.Settings')">
    <FtToggleSwitch
      :label="t('Downloads.Wi-Fi only')"
      :default-value="wifiOnly"
      :compact="true"
      @change="updateWifiOnly"
    />
    <FtToggleSwitch
      :label="t('Downloads.Prefer local files')"
      :default-value="preferLocal"
      :compact="true"
      @change="value => store.dispatch('updateDownloadsPreferLocal', value)"
    />
    <FtSelect
      :placeholder="t('Downloads.Concurrent downloads')"
      :value="String(concurrency)"
      :select-names="['1', '2', '3']"
      :select-values="['1', '2', '3']"
      :icon="['fas', 'download']"
      @change="updateConcurrency"
    />
    <FtSelect
      :placeholder="t('Downloads.Default video format')"
      :value="defaultVideoFormat"
      :select-names="videoFormatNames"
      :select-values="videoFormatValues"
      :icon="['fas', 'film']"
      @change="value => store.dispatch('updateDownloadsDefaultVideoFormat', value)"
    />
    <FtSelect
      :placeholder="t('Downloads.Default audio format')"
      :value="defaultAudioFormat"
      :select-names="audioFormatNames"
      :select-values="audioFormatValues"
      :icon="['fas', 'music']"
      @change="value => store.dispatch('updateDownloadsDefaultAudioFormat', value)"
    />
    <FtFlexBox>
      <FtButton
        :label="t('Downloads.Select directory')"
        @click="selectDirectory"
      />
      <FtButton
        :label="t('Downloads.Reset directory permission')"
        @click="resetDirectory"
      />
    </FtFlexBox>
    <p v-if="directory">
      {{ directory }}
    </p>
  </FtSettingsSection>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import FtButton from '../FtButton/FtButton.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtSelect from '../FtSelect/FtSelect.vue'
import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'
import store from '../../store'
import {
  getDownloadDirectory,
  getDownloadSettings,
  resetDownloadDirectory,
  selectDownloadDirectory,
  updateDownloadSettings,
} from '../../helpers/android/downloads'

const { t } = useI18n()
const wifiOnly = computed(() => store.getters.getDownloadsWifiOnly)
const concurrency = computed(() => store.getters.getDownloadsConcurrency)
const defaultVideoFormat = computed(() => store.getters.getDownloadsDefaultVideoFormat)
const defaultAudioFormat = computed(() => store.getters.getDownloadsDefaultAudioFormat)
const preferLocal = computed(() => store.getters.getDownloadsPreferLocal)
const directory = ref(getDownloadDirectory())
const videoFormatValues = ['auto', 'mp4', 'webm']
const audioFormatValues = ['auto', 'm4a', 'webm']
const videoFormatNames = ['Auto', 'MP4', 'WebM']
const audioFormatNames = ['Auto', 'M4A', 'WebM']

function syncNativeSettings() {
  updateDownloadSettings({
    wifiOnly: wifiOnly.value,
    concurrency: concurrency.value,
  })
}

function updateWifiOnly(value) {
  store.dispatch('updateDownloadsWifiOnly', value)
  updateDownloadSettings({ wifiOnly: value, concurrency: concurrency.value })
}

function updateConcurrency(value) {
  const parsed = Number(value)
  store.dispatch('updateDownloadsConcurrency', parsed)
  updateDownloadSettings({ wifiOnly: wifiOnly.value, concurrency: parsed })
}

async function selectDirectory() {
  const selected = await selectDownloadDirectory(true)
  if (selected) directory.value = selected
}

function resetDirectory() {
  resetDownloadDirectory()
  directory.value = null
}

onMounted(() => {
  const native = getDownloadSettings()
  if (native.wifiOnly !== wifiOnly.value) store.dispatch('updateDownloadsWifiOnly', native.wifiOnly)
  if (native.concurrency !== concurrency.value) store.dispatch('updateDownloadsConcurrency', native.concurrency)
  syncNativeSettings()
})
</script>
