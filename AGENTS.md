# Repository instructions

Read these before modifying the repository:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for code ownership, runtime boundaries, and generated files.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for commands and Android validation.

For Android work, require ADB access to the connected physical test phone. Check `adb devices -l` before making validation claims and use the detected device for install, launch, logs, and smoke tests.

ADB profile safety is mandatory: use personal/mainland Android user `0` only. Before any command, verify `adb shell am get-current-user` returns `0`; never use work-profile user IDs such as `10`, `--user 10`, or package/data paths under `/data/user/10/`. Prefer explicit `--user 0` for `adb install`, `am start`, `am force-stop`, and `pm grant`. Do not switch users from automation. If current user is not `0`, stop and report validation as unavailable.

Do not edit generated bundles in `dist/` or `android/app/src/main/assets/` by hand. Regenerate them with the documented packaging commands. Keep generated output, local data, logs, and all files under `docs/plans/` out of commits. Task plans are local-only and must never be added to Git or staged.

Build Android APK inside Docker using `docker compose run --rm android-build ...`; do not rely on host `pnpm` or Android toolchain. Use the container for `pnpm install --frozen-lockfile`, `pnpm run pack:android:dev`, and `android/./gradlew assembleDebug`.
