# Android beta releases

Each squash merge into `beta/0.26.0` triggers `Android Beta Release`. No manual version bump is required.

- Base version comes from `package.json`.
- Full version is `<base-version>.<github.run_number>`, starting with `0.26.0.1` for workflow run 1.
- Each run creates its own tag and GitHub prerelease. Both names equal full version, without `v` prefix.
- APK download filename is `freetube-<full-version>-beta-release.apk`.
- Native Android `versionName` equals full version; `versionCode` equals workflow run number.
- Application ID is `io.freetubeapp.freetubeandroid`, not nightly ID. Web About still shows shared package version.

Reruns retain version and tag, and replace APK for that same commit. Failed runs consume numbers; rerun failed jobs to recover their release. Numbering continues when package version changes. Preserve workflow identity and append-only branch history to retain update ordering. Do not add concurrency cancellation: each squash commit needs its own build.

Signing uses these repository secrets only:

```text
ANDROID_BETA_RELEASE_KEYSTORE_BASE64
ANDROID_BETA_RELEASE_KEYSTORE_PASSWORD
ANDROID_BETA_RELEASE_KEY_ALIAS
ANDROID_BETA_RELEASE_KEY_PASSWORD
```

CI creates temporary signing files, builds production assets and signed release APK through `android-build` Docker service, verifies APK signature, then removes signing files. Nightly workflow and credentials remain separate.

Android permits updates only with matching application ID, signing certificate and increasing version code. Beta key cannot update installations signed with another key. Do not uninstall existing apps or remove data to bypass this constraint without explicit approval.

Run focused workflow checks without signing secrets or GitHub mutations:

```bash
node _scripts/test-android-beta-release.mjs
```
