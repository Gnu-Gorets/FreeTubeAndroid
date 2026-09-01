<template>
  <div class="settingsSection">
    <h2>{{ t('Downloads.Settings.Title') }}</h2>
    <label>
      {{ t('Downloads.Settings.Concurrent downloads') }}
      <select
        v-model.number="concurrency"
        @change="saveConcurrency"
      >
        <option
          v-for="value in [1, 2, 3, 4, 5]"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
    </label>
    <p>
      {{ t('Downloads.Settings.Download folder', { directory }) }}
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

const { t } = useI18n()
const DEFAULT_DIRECTORY = 'data://downloads'
const concurrency = ref(Number(localStorage.getItem('freetube-download-concurrency') || 5))
const directory = ref(localStorage.getItem('freetube-download-directory') || DEFAULT_DIRECTORY)

function saveConcurrency() {
  localStorage.setItem('freetube-download-concurrency', String(concurrency.value))
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
