# Development workflow

## Prerequisites

- Node.js and `pnpm` compatible with lockfile.
- JDK 17 for Android builds.
- Android SDK with API 36 and Android build tools 36.0.0.
- `adb` on `PATH` for Android installation, logs, and smoke tests.
- `ffmpeg` on `PATH` for 720p/15 fps Android screen recordings.

## JavaScript setup

```bash
pnpm install
```

Run Electron development mode:

```bash
pnpm dev
```

Run browser/PWA development mode:

```bash
pnpm dev:web
```

Run main checks:

```bash
pnpm run lint
pnpm run lint-json
pnpm run lint-yml
pnpm run checkforbadtemplates
```

Useful host packaging commands:

```bash
pnpm run pack
pnpm run pack:web
```

Build Android packaging in Docker. This workflow uses production web assets, even for `assembleDebug`, so installed APK does not contain development source maps:

```bash
docker compose run --rm android-build bash -lc \
  'pnpm install --frozen-lockfile && \
   pnpm run pack:android:core && \
   cd android && ./gradlew assembleDebug'
```

`pack:android:dev` is reserved for WebView debugging. Do not use it for normal APK installation or performance testing.

Build local unsigned nightly release:

```bash
docker compose run --rm android-nightly
```

This uses nightly application ID and `package.json` version with `-nightly.local` suffix. For signing and GitHub nightly release setup, see `docs/ANDROID_NIGHTLY_SIGNING.md`.

## Android build and install

Build from repository root with documented Docker workflow:

```bash
docker compose run --rm android-build bash -lc \
  'pnpm install --frozen-lockfile && \
   pnpm run pack:android:core && \
   cd android && ./gradlew assembleDebug'
```

Install resulting APK from host with `adb` only after required device checks. debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Stable application ID is `io.freetubeapp.freetubeandroid`; nightly application ID is `io.freetubeapp.freetubeandroid.nightly`.

### Build reproducibility

Android builds are functionally reproducible with documented Docker and toolchain workflow, but byte-for-byte APK reproducibility is not currently guaranteed. generated `assets/web.js` output/source map can differ between equivalent builds. Do not commit generated build output; validate functional artifacts with `assembleDebug` and device smoke tests.

## Required physical test device

Android work must use connected physical test phone whenever available. Android has main personal and work profiles; all Android interaction through `adb` must use personal profile (`user 0`), never work profile.

Before Android work or validation, run:

```bash
adb devices -l
adb get-state
adb shell am get-current-user
```

physical phone must be present with state `device`, and `adb shell am get-current-user` must print `0`. If it is missing, unlock phone, confirm USB debugging authorization dialog, reconnect USB, and do not claim Android validation is complete until ADB is working. Switch to personal profile before any `adb` install, launch, log collection, or test command.

Install and launch on connected phone:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.freetubeapp.freetubeandroid/.MainActivity
```

Collect native and WebView logs when diagnosing Android behavior:

```bash
adb logcat -c
adb logcat -v brief
```

## Android smoke test

repository includes device-driven smoke test. Do not change phone-level Android display scale. Set scale only inside development app through its `UI Scale` setting, which smoke test normalizes to `100%`.

Before every smoke test run:

1. Use phone's existing Android display scale without changing it.
2. Keep phone unlocked for `unlocked` suite.

```bash
adb devices -l
adb shell am get-current-user
_scripts/android-smoke-test.sh --serial ZY32KFTHMV --suite unlocked
```

smoke script also checks that active Android user is personal profile `0`, installs APK for `user 0`, and records run at 720p/15 fps as `screen.mp4`. It does not change Android system display scale. It returns `77` when `adb` or device is unavailable. Its artifacts are written under ignored `tmp/android-smoke/`.

smoke test can run smaller test or suite when debugging:

```bash
_scripts/android-smoke-test.sh --test cold-start
_scripts/android-smoke-test.sh --suite locked
```

## Android manual test recording

Record manual tests at 720p/15 fps and press Ctrl-C when finished:

```bash
_scripts/android-screen-record.sh --serial ZY32KFTHMV
```

Recordings are written under ignored `tmp/android-screen-record/`. Use `--output PATH` to choose another file.

## Change workflow

1. Read `docs/ARCHITECTURE.md` and this file before changing code.
2. Inspect nearest existing implementation and all callers before adding new helper or platform branch.
3. For Android changes, check required ADB device first and use physical phone for validation.
4. Regenerate Android assets with `pnpm run pack:android:core` for normal builds, or `pnpm run pack:android:dev` only for explicit WebView debugging; do not hand-edit generated bundle files.
5. Run smallest relevant lint/build/smoke checks and report any check skipped because device or environment was unavailable.
6. Keep generated output, local data, and logs out of commits.
