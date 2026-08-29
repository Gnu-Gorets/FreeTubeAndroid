import Datastore from '@seald-io/nedb'
import * as androidStorage from '../renderer/helpers/android/nedb'
import { readFile, writeFile } from '../renderer/helpers/android/storage'

let dbPath = null

if (process.env.IS_ELECTRON_MAIN) {
  const { app } = require('electron')
  const { join } = require('path')
  // this code only runs in the electron main process, so hopefully using sync fs code here should be fine 😬
  const { statSync, realpathSync } = require('fs')
  const userDataPath = app.getPath('userData') // This is based on the user's OS
  dbPath = (dbName) => {
    let path = join(userDataPath, `${dbName}.db`)

    // returns undefined if the path doesn't exist
    if (statSync(path, { throwIfNoEntry: false })?.isSymbolicLink) {
      path = realpathSync(path)
    }

    return path
  }
} else {
  dbPath = (dbName) => `${dbName}.db`
}

/**
 * @param {string} name
 */
function createDatastore(name) {
  return new Datastore({
    filename: dbPath(name),
    autoload: !process.env.IS_ELECTRON_MAIN,
    // Automatically clean up corrupted data, instead of crashing
    corruptAlertThreshold: 1,
    storage: process.env.IS_ANDROID ? androidStorage : undefined
  })
}

export const settings = createDatastore('settings')
export const profiles = createDatastore('profiles')
export const playlists = createDatastore('playlists')
export const history = createDatastore('history')
export const searchHistory = createDatastore('search-history')
export const subscriptionCache = createDatastore('subscription-cache')

export const migrationReady = process.env.IS_ANDROID ? migrateLegacyIndexedDb() : Promise.resolve()

async function migrateLegacyIndexedDb() {
  const marker = 'data://.indexeddb-migration-complete'
  if (await readFile(marker)) return

  const names = ['settings', 'profiles', 'playlists', 'history', 'search-history', 'subscription-cache']
  const legacy = names.map((name) => new Datastore({ filename: `${name}.db`, autoload: true }))
  await Promise.all(legacy.map((database) => database.autoloadPromise))

  const native = [settings, profiles, playlists, history, searchHistory, subscriptionCache]
  const nativeCounts = await Promise.all(native.map((database) => database.countAsync({})))
  if (nativeCounts.some((count) => count > 0)) {
    await writeFile(marker, 'native storage already initialized')
    return
  }

  for (let index = 0; index < legacy.length; index++) {
    const documents = await legacy[index].findAsync({})
    if (documents.length > 0) await native[index].insertAsync(documents)
  }
  await writeFile(marker, 'migration completed')
}
