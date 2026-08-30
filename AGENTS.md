# Repository instructions

Read these before modifying the repository:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for code ownership, runtime boundaries, and generated files.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for commands and Android validation.

For Android work, require ADB access to the connected physical test phone. Check `adb devices -l` before making validation claims and use the detected device for install, launch, logs, and smoke tests.

Do not edit generated bundles in `dist/` or `android/app/src/main/assets/` by hand. Regenerate them with the documented packaging commands. Keep generated output, local data, and logs out of commits.
