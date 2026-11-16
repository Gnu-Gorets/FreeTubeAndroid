import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'

const workflow = load(readFileSync('.github/workflows/android-beta-release.yml', 'utf8'))
assert.deepEqual(workflow.on, { release: { types: ['published'] } })
assert.equal(workflow.concurrency, undefined)
assert.equal(workflow.jobs['beta-release'].concurrency, undefined)
const job = workflow.jobs['beta-release']
assert.equal(job.env.GH_REPO, '$' + '{{ github.repository }}')
assert.match(job.if, /github\.event\.release\.prerelease/)
assert.match(job.if, /startsWith\(github\.event\.release\.tag_name, '0\.26\.0\.'\)/)
assert.doesNotMatch(JSON.stringify(workflow), /gh release (create|edit)|git (tag|push)|--notes/)
const step = name => job.steps.find(item => item.name === name)
assert.equal(step('Checkout').with.ref, '$' + '{{ github.event.release.tag_name }}')
assert.equal(step('Read beta version').env.RELEASE_TAG, '$' + '{{ github.event.release.tag_name }}')
assert.equal(step('Checkout').with['fetch-depth'], 0)
assert.equal(step('Checkout').with['persist-credentials'], false)
assert.equal(step('Remove beta signing files').if, 'always()')
assert.match(step('Build signed beta release APK').run, /docker compose run/)
assert.match(step('Build signed beta release APK').run, /-PandroidApplicationId=io\.freetubeapp\.freetubeandroid\s/)
assert.match(step('Build signed beta release APK').run, /apksigner" verify/)
assert.doesNotMatch(JSON.stringify(workflow), /ANDROID_NIGHTLY|android-nightly|#freetube/)

const directory = mkdtempSync(join(tmpdir(), 'freetube-beta-test-'))
const env = {
  ...process.env,
  GITHUB_OUTPUT: join(directory, 'output'),
  GITHUB_RUN_NUMBER: '1',
  GITHUB_RUN_ID: '123',
  GH_REPO: 'Gnu-Gorets/FreeTubeAndroid',
}
function run(command, args = [], overrides = {}) {
  return spawnSync(command, args, { cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8' })
}
function success(result) {
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function version(base, number, tag = `${base}.${number}`) {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: base }))
  writeFileSync(env.GITHUB_OUTPUT, '')
  return run('bash', ['-c', step('Read beta version').run], { GITHUB_RUN_NUMBER: number, RELEASE_TAG: tag })
}
try {
  success(run('git', ['init', '--quiet']))
  success(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'test']))
  env.GITHUB_SHA = success(run('git', ['rev-parse', 'HEAD']))
  success(run('git', ['tag', '0.26.0.1']))
  success(run('git', ['tag', '0.27.0.11']))
  for (const number of ['1', '2', '10', '1']) {
    if (number !== '1') success(run('git', ['tag', `0.26.0.${number}`]))
    success(version('0.26.0', number))
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `version_name=0.26.0.${number}\napk_name=freetube-0.26.0.${number}-beta-release.apk\n`)
  }
  success(version('0.27.0', '11'))
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /version_name=0\.27\.0\.11/)
  for (const base of ['../0.26.0', '0.26.0-beta', '', '0.26.0\nunsafe']) {
    assert.notEqual(version(base, '1').status, 0)
  }
  for (const number of ['0', '-1', '01', '1.2', '2100000001', '99999999999999999999']) {
    assert.notEqual(version('0.26.0', number).status, 0)
  }
  success(version('0.26.0', '12', '0.26.0.1'))
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /version_name=0\.26\.0\.1/)
  for (const tag of ['0.26.0.0', '0.26.0.01', '0.27.0.11', 'v0.26.0.1', '0.26.0.1\nunsafe', '0.26.0.99']) {
    assert.notEqual(version('0.26.0', '1', tag).status, 0)
  }
  success(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'next']))
  assert.notEqual(version('0.26.0', '1').status, 0)

  mkdirSync(join(directory, 'android/app'), { recursive: true })
  const signingEnv = {
    ANDROID_BETA_RELEASE_KEYSTORE_BASE64: Buffer.from('synthetic keystore').toString('base64'),
    ANDROID_BETA_RELEASE_KEYSTORE_PASSWORD: ' spaces\\colon:equals=\n\r\t"é😀',
    ANDROID_BETA_RELEASE_KEY_ALIAS: 'beta alias',
    ANDROID_BETA_RELEASE_KEY_PASSWORD: 'key\\password',
  }
  for (const [key, expression] of Object.entries(step('Prepare beta signing files').env)) {
    assert.equal(expression, `\${{ secrets.${key} }}`)
    assert.notEqual(run('bash', ['-c', step('Prepare beta signing files').run], { ...signingEnv, [key]: '' }).status, 0)
  }
  success(run('bash', ['-c', step('Prepare beta signing files').run], signingEnv))
  assert.equal(readFileSync(join(directory, 'android/app/beta-release.keystore'), 'utf8'), 'synthetic keystore')
  const properties = readFileSync(join(directory, 'android/keystore.properties'), 'utf8').trim().split('\n')
  assert.equal(properties[0], 'storeFile=beta-release.keystore')
  for (const [index, name] of ['KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD'].entries()) {
    const escaped = properties[index + 1].split('=')[1]
    assert.equal(JSON.parse(`"${escaped}"`), signingEnv[`ANDROID_BETA_RELEASE_${name}`])
  }
  assert.equal(statSync(join(directory, 'android/keystore.properties')).mode & 0o777, 0o600)

  const bin = join(directory, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$GH_LOG"\nexit "$UPLOAD_STATUS"\n')
  chmodSync(join(bin, 'gh'), 0o700)
  mkdirSync(join(directory, 'android/app/build/outputs/apk/release'), { recursive: true })
  writeFileSync(join(directory, 'android/app/build/outputs/apk/release/app-release.apk'), 'signed fixture')
  for (const status of ['1', '0']) {
    const log = join(directory, 'gh-log')
    writeFileSync(log, '')
    const result = run('bash', ['-c', step('Upload beta APK').run], {
      PATH: `${bin}:${env.PATH}`,
      GH_LOG: log,
      UPLOAD_STATUS: status,
      VERSION_NAME: '0.26.0.1',
      APK_NAME: 'freetube-0.26.0.1-beta-release.apk',
    })
    assert.equal(result.status, Number(status), result.stderr)
    assert.equal(readFileSync(join(directory, 'freetube-0.26.0.1-beta-release.apk'), 'utf8'), 'signed fixture')
    const calls = readFileSync(log, 'utf8')
    assert.equal(calls, 'release upload 0.26.0.1 freetube-0.26.0.1-beta-release.apk --clobber\n')
  }
  success(run('bash', ['-c', step('Remove beta signing files').run]))
  assert.equal(existsSync(join(directory, 'android/keystore.properties')), false)
  assert.equal(existsSync(join(directory, 'android/app/beta-release.keystore')), false)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
console.log('Android beta release: PASS')
