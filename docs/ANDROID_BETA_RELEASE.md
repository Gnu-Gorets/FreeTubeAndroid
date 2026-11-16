# Android beta releases

Pushes to `beta/0.26.0` do not create tags or releases. Create and push tags manually after one or more commits, then publish GitHub prerelease with your own notes. Publishing triggers `Android Beta Release`, which builds APK from release tag and attaches it without changing release title or notes.

Release tag must point to commit containing this workflow update. Publishing drafts as prereleases is supported. Saving drafts, pushing tags, and editing notes do not trigger builds.

- Base version comes from `package.json`.
- Full version comes from manually created tag: `<base-version>.<positive-integer>`, such as `0.26.0.1`, without `v` prefix or leading zeros in suffix.
- Workflow accepts published prereleases with tags starting with `0.26.0.`. Tag base must match `package.json` at tagged commit.
- APK download filename is `freetube-<full-version>-beta-release.apk`.
- Native Android `versionName` equals full version; `versionCode` equals workflow run number.
- Application ID is `io.freetubeapp.freetubeandroid`, not nightly ID. Web About still shows shared package version.

Reruns retain version and replace APK on existing release. Upload failure fails workflow; it never creates missing releases or tags. Failed runs consume version codes; rerun failed jobs to recover APK. Version code follows workflow run number, not tag suffix. Publish releases in update order, preserve workflow identity, and do not move published tags.

## Manual release notes

Write Android fork changes first and upstream link last. Example for `0.26.0.1`:

```markdown
## Android

- Describe Android changes since previous fork release.

## Upstream

[FreeTube v0.26.0-beta release notes](https://github.com/FreeTubeApp/FreeTube/releases/tag/v0.26.0-beta)
```

Workflow does not generate or overwrite these notes.

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
