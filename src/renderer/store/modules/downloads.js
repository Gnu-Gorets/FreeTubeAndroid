import {
  cancelDownload as cancelNativeDownload,
  deleteDownload as deleteNativeDownload,
  enqueueDownload as enqueueNativeDownload,
  getDownloads as getNativeDownloads,
  pauseDownload as pauseNativeDownload,
  resumeDownload as resumeNativeDownload,
  retryDownload as retryNativeDownload,
  refreshDownload as refreshNativeDownload
} from '../../helpers/android/downloads'

const state = {
  missions: [],
  updatesStarted: false
}

const getters = {
  getDownloadMissions: state => state.missions,
  getDownloadMissionById: state => id => state.missions.find(mission => mission.id === id)
}

const actions = {
  grabDownloads({ commit }) {
    commit('setDownloadMissions', getNativeDownloads())
  },

  startDownloadUpdates({ commit }) {
    if (!process.env.IS_ANDROID || state.updatesStarted) return
    state.updatesStarted = true
    window.addEventListener('download-update', ({ detail }) => {
      commit('setDownloadMissions', detail)
    })
  },

  enqueueDownload({ dispatch }, request) {
    const id = enqueueNativeDownload(request)
    dispatch('grabDownloads')
    return id
  },

  pauseDownload({ dispatch }, id) {
    const result = pauseNativeDownload(id)
    dispatch('grabDownloads')
    return result
  },

  resumeDownload({ dispatch }, id) {
    const result = resumeNativeDownload(id)
    dispatch('grabDownloads')
    return result
  },

  cancelDownload({ dispatch }, id) {
    const result = cancelNativeDownload(id)
    dispatch('grabDownloads')
    return result
  },

  retryDownload({ dispatch }, id) {
    const result = retryNativeDownload(id)
    dispatch('grabDownloads')
    return result
  },

  refreshDownload({ dispatch }, { id, request }) {
    const result = refreshNativeDownload(id, request)
    dispatch('grabDownloads')
    return result
  },

  deleteDownload({ dispatch }, id) {
    const result = deleteNativeDownload(id)
    dispatch('grabDownloads')
    return result
  }
}

const mutations = {
  setDownloadMissions(state, missions) {
    state.missions = Array.isArray(missions) ? missions : []
  }
}

export default {
  namespaced: false,
  state,
  getters,
  actions,
  mutations
}
