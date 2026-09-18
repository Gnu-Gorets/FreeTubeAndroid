# External Player chooser delay analysis

## Scenario

- Device: `ZY32KFTHMV`, physical Android device, `user 0`.
- App: `io.freetubeapp.freetubeandroid`.
- Action: tap External Player button on first subscription card through ADB.

## Results

Before diagnostic changes, chooser dispatch occurred after `resolve-done elapsedMs=6020`. After rebuilding with logs, the same flow completed `resolve-done elapsedMs=3054`.

Native timings in the diagnostic run:

```text
bridge-start
headers-parsed elapsedMs=17
relay-registration-start elapsedMs=17
relay-registered elapsedMs=20
chooser-start elapsedMs=21
chooser-intent-ready elapsedMs=21
chooser-dispatched elapsedMs=29
```

The chooser delay is variable, but native relay setup and chooser dispatch take about 30 ms. The wait happens before `AndroidBridge.openExternalPlayer()`.

## 5-Why analysis

1. `handleExternalPlayer()` waits for `getLocalVideoInfo()` before calling Android bridge.
2. `getLocalVideoInfo()` performs API requests, token generation, parsing and stream URL selection.
3. Android receives resolved media/manifest/stream payload only after this work completes.
4. Native chooser needs a relay URL and playable MIME-compatible stream data. Raw YouTube watch URL is not equivalent.
5. Root cause: chooser presentation is coupled to asynchronous media resolution.

## Changes

Added diagnostic logs only:

- `src/renderer/helpers/utils.js`: bridge entry and payload flags.
- `android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt`: bridge thread, header parsing, relay registration, intent creation and chooser dispatch stages.

No generated assets were edited manually.

## Checks

- `adb devices -l`: passed.
- `adb get-state`: `device`.
- `adb shell am get-current-user`: `0`.
- APK install and launch: passed.
- External Player tap before logs: reproduced, about 6.0 s.
- External Player tap after logs: reproduced, about 3.1 s.
- ESLint for changed JavaScript files: passed.
- Docker build: passed with `pnpm install --no-frozen-lockfile` after documented frozen-lockfile failure caused by existing package-manager metadata mismatch.

## Conclusion

The delay is not caused by Android chooser or relay setup. A UX fix requires decoupling chooser presentation from stream resolution or introducing native asynchronous handoff. This commit adds evidence and logging only; it does not open an unusable chooser prematurely.
