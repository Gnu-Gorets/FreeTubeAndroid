<template>
  <div class="settingsSection">
    <h2>{{ t('Downloads.Settings.Title') }}</h2>
    <label>
      {{ t('Downloads.Settings.Concurrent downloads') }}
      <input
        v-model="concurrency"
        inputmode="numeric"
        pattern="[0-9]*"
        :aria-label="t('Downloads.Settings.Concurrent downloads')"
        @input="saveConcurrency"
      >
    </label>
    <p>
      {{ t('Downloads.Settings.Download folder', { directory: directory === DEFAULT_DIRECTORY ? 'Downloads/FreeTube' : directory }) }}
    </p>
    <button
      type="button"
      @click="chooseDirectory"
    >
      {{ t('Downloads.Settings.Choose folder') }}
    </button>
    <button
      v-if="directory !== DEFAULT_DIRECTORY"
      type="button"
      @click="resetDirectory"
    >
      {{ t('Downloads.Settings.Use default folder') }}
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import android from 'android'
import { awaitAsyncResult } from '../helpers/android/jsinterface'
import { digitsOnly } from '../helpers/android/download-settings.mjs'

const { t } = useI18n()
const DEFAULT_DIRECTORY = 'data://downloads/FreeTube'
const LEGACY_DEFAULT_DIRECTORIES = ['data://downloads', 'data://downloads/Freetube', 'data://downloads/FreetTube']
const concurrency = ref(localStorage.getItem('freetube-download-concurrency') || '1')
const savedDirectory = localStorage.getItem('freetube-download-directory')
const directory = ref(!savedDirectory || LEGACY_DEFAULT_DIRECTORIES.includes(savedDirectory) ? DEFAULT_DIRECTORY : savedDirectory)
if (directory.value !== savedDirectory) localStorage.setItem('freetube-download-directory', directory.value)

function saveConcurrency() {
  concurrency.value = digitsOnly(concurrency.value)
  localStorage.setItem('freetube-download-concurrency', concurrency.value || '1')
  window.dispatchEvent(new CustomEvent('download-settings-changed'))
}

async function chooseDirectory() {
  const uri = await awaitAsyncResult(android.requestDirectoryAccessDialog())
  if (uri && uri !== 'USER_CANCELED') {
    directory.value = uri
    localStorage.setItem('freetube-download-directory', uri)
    window.dispatchEvent(new CustomEvent('download-settings-changed'))
  }
}

function resetDirectory() {
  directory.value = DEFAULT_DIRECTORY
  localStorage.setItem('freetube-download-directory', DEFAULT_DIRECTORY)
  window.dispatchEvent(new CustomEvent('download-settings-changed'))
}
</script>
