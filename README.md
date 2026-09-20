<p align="center">
  <img alt="FreeTube logo" src="_icons/iconColor.png" width="192">
</p>

<h1 align="center">FreeTube Android</h1>

<p align="center">
  Private YouTube client for Android
</p>

<p align="center">
  <a href="https://github.com/Gnu-Gorets/FreeTubeAndroid/releases">Download</a> ·
  <a href="https://github.com/Gnu-Gorets/FreeTubeAndroid/issues">Report issue</a> ·
  <a href="https://github.com/Gnu-Gorets/FreeTubeAndroid/discussions">Discussions</a>
</p>

> [!NOTE]
> Project is in beta. Bugs and missing features are expected.

## What this is

FreeTube Android packages FreeTube renderer inside native Android WebView shell.

This repository keeps shared FreeTube UI and adds Android lifecycle, WebView, media and file handling. Desktop runtime is not target here.

## Runtime model

Android app has two layers:

* `src/renderer/` contains shared FreeTube UI and product logic
* `android/` contains native WebView shell, lifecycle and media integration

No official YouTube API is used. Built in extractor can use optional [Invidious API](https://github.com/iv-org/invidious).

Subscriptions, playlists and history stay on device. YouTube can still receive video requests and IP address. Use VPN or Tor if network privacy matters too.

## Android features

* No ads inside video flow
* No Google account required for subscriptions
* External player and picture in picture support
* SponsorBlock
* Themes, profiles, keyboard shortcuts and distraction free settings

## Repository map

* `src/renderer/` Shared UI, router, store and localization
* `android/app/src/main/java/` Native Android bridge and lifecycle code
* `_scripts/` Webpack, packaging and development tools
* `docs/` Architecture, build and test documentation

## Download

### Release APK

Download current release from [GitHub Releases](https://github.com/Gnu-Gorets/FreeTubeAndroid/releases).

### Nightly APK

Each push to `development` builds signed prerelease APK. Latest file is [freetube-nightly.apk](https://github.com/Gnu-Gorets/FreeTubeAndroid/releases/tag/nightly).

Nightly uses separate application ID `io.freetubeapp.freetubeandroid.nightly`, so stable and nightly builds can be installed together.

## Build APK

Docker provides Android toolchain and keeps host setup out of build path:

```bash
docker compose run --rm android-build bash -lc \
  'pnpm install --frozen-lockfile && \
   pnpm run pack:android:core && \
   cd android && ./gradlew assembleDebug'
```

Build output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Check changes

Run host checks before pull request:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run lint-json
pnpm run lint-yml
pnpm run checkforbadtemplates
```

Android validation uses physical device and personal Android profile `user 0`.

## Contributing

Shared product changes usually belong in [FreeTube](https://github.com/FreeTubeApp/FreeTube). Android lifecycle, WebView, native bridge, workflows and Android specific fixes belong here.

Read [Contribution Guidelines](https://github.com/FreeTubeApp/FreeTube/blob/development/CONTRIBUTING.md) before opening pull request.

## Links

* [FreeTube documentation](https://docs.freetubeapp.io/)
* [Issues](https://github.com/Gnu-Gorets/FreeTubeAndroid/issues)
* [Discussions](https://github.com/Gnu-Gorets/FreeTubeAndroid/discussions)
* [FreeTube Matrix room](https://matrix.to/#/#freetube:matrix.org)

## License

[GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html) or later.
