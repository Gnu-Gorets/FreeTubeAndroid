# Repository Instructions

## Before changes

1. For Android, build, runtime, or packaging changes, read `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` first.
2. Before changing behavior, inspect implementation, callers, tests, and docs. Surface conflicts instead of guessing. For bugs, trace shared callers and fix the narrowest root cause.
3. Keep UI in `src/renderer/` and Android lifecycle/bridge code in `android/app/src/main/java/`. Preserve Electron, PWA, and Android boundaries; reuse existing interfaces and keep exposed JS bridge methods narrow.

## Checks and builds

1. Host checks use `pnpm@11`:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run lint-json
pnpm run lint-yml
pnpm run checkforbadtemplates
```

2. Android packaging and builds use Docker only. Do not use host Android tooling or host `pnpm` for them:

```bash
docker compose run --rm android-build bash -lc \
  'pnpm install --frozen-lockfile && pnpm run pack:android:core && \
   cd android && ./gradlew assembleDebug'
```

3. APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Host `adb` is for device installation and tests only.
4. Never hand-edit generated `dist/` or `android/app/src/main/assets/`; regenerate them. Keep generated output, local data, logs, screenshots, recordings, and `docs/plans/` out of commits.

## Android device safety

Before device interaction, run:

```bash
adb devices -l
adb get-state
adb shell am get-current-user
```

Proceed only when the physical device state is `device` and active user is `0`.

1. Use explicit `--user 0` for install, start, stop, and grant.
2. Never use or switch to work profile `10` or `/data/user/10/`.
3. Test only `io.freetubeapp.freetubeandroid` unless explicitly approved.
4. Never change system density, scale, resolution, font scale, or display settings. App `UI Scale` is allowed only for documented FreeTube smoke normalization.
5. Do not change device data, app state, or system settings during manual testing unless explicitly requested.

## Git workflow

1. Direct commits and force pushes to `development` are allowed only for repository-owner-approved maintenance. Preserve Conventional Commits and coordinate force pushes with active contributors.
2. For development work, do not commit or push directly. Start from current `development` in a separate feature branch, push the branch, and merge only through a PR targeting `development`.
3. Open PRs only in `Gnu-Gorets/FreeTubeAndroid`, never upstream `FreeTubeApp/FreeTube`.
4. Use GitHub `Squash and merge`; do not use merge commits or rebase merge.
5. Commit format: `<type>[optional scope]: <description>`.
