# Android Beta Release

This document covers Android beta prereleases from `beta/0.26.0`. The beta APK uses its own application ID, release names, and signing key. Its displayed application name stays `FreeTube`.

## Beta signing key

The GitHub beta workflow requires this key and publishes signed APKs. The documented local `android-beta-release` build remains unsigned.

Run from repository root:

```bash
mkdir -p ~/private/freetube-signing
chmod 700 ~/private/freetube-signing

docker compose run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$HOME/private/freetube-signing:/keys" \
  android-build bash -lc \
  'umask 077; keytool -genkeypair -v \
    -keystore /keys/freetube-beta-release.keystore \
    -alias freetube-beta-release \
    -keyalg RSA -keysize 2048 -validity 10000'
```

`keytool` asks for the keystore password twice. It uses the same password for the key. Press `Enter` for the certificate fields, then answer `yes` to confirm.

Check the alias and record the SHA-256 fingerprint:

```bash
docker compose run --rm \\
  --user "$(id -u):$(id -g)" \\
  -v "$HOME/private/freetube-signing:/keys" \\
  android-build \\
  keytool -list -v -keystore /keys/freetube-beta-release.keystore
```

Keep the key and password in a separate KeePassXC entry named `FreeTube Android Beta Release`. Record these values:

- keystore: `freetube-beta-release.keystore`;
- alias: `freetube-beta-release`;
- application ID: `io.freetubeapp.freetubeandroid.betaRelease`;
- SHA-256 certificate fingerprint;
- keystore and key passwords.

Keep encrypted backups of KeePassXC. Never commit the keystore.

## GitHub Actions secrets

Before a push or manual run on `beta/0.26.0`, set these repository secrets to real values. Empty placeholders are not enough; the workflow fails if any value is blank or missing.

Open `Repository → Settings → Secrets and variables → Actions` and create or update:

```text
ANDROID_BETA_RELEASE_KEYSTORE_BASE64
ANDROID_BETA_RELEASE_KEYSTORE_PASSWORD
ANDROID_BETA_RELEASE_KEY_ALIAS
ANDROID_BETA_RELEASE_KEY_PASSWORD
```

Use these values:

- `ANDROID_BETA_RELEASE_KEYSTORE_BASE64`: Base64-encoded keystore.
- `ANDROID_BETA_RELEASE_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_BETA_RELEASE_KEY_ALIAS`: `freetube-beta-release`.
- `ANDROID_BETA_RELEASE_KEY_PASSWORD`: key password. For this PKCS12 keystore, it is the same as the keystore password.

To set the Base64 secret without printing its value or adding it to shell history:

```bash
base64 -w 0 ~/private/freetube-signing/freetube-beta-release.keystore | \\
  gh secret set ANDROID_BETA_RELEASE_KEYSTORE_BASE64 \\
    --repo Gnu-Gorets/FreeTubeAndroid
```

Enter the three password/alias values in the Actions settings page. Keep existing `ANDROID_NIGHTLY_*` secrets unchanged. GitHub does not show secret values after saving.

## Local unsigned beta build

Keystore is not needed for a local build:

```bash
docker compose run --rm android-beta-release
```

The service uses the `-beta-release.local` version suffix and the beta application ID by default. The displayed application name remains `FreeTube`. The APK is unsigned and cannot update an installed signed app.

Output:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

## GitHub beta prereleases

Each push to `beta/0.26.0` builds an APK and creates a separate prerelease for each commit in that push. Version numbers count commits after `v0.26.0-beta`. The first squash-merged commit gets `0.26.0.1`; the next gets `0.26.0.2`.

The beta application ID is `io.freetubeapp.freetubeandroid.betaRelease`. The existing nightly app keeps its separate application ID, `io.freetubeapp.freetubeandroid.nightly`.

Each prerelease has an `android-beta-release-v<version>-<commit>` tag and a signed `freetube-android-beta-release-<version>.apk` asset. The workflow checks the APK signature, application ID, version, and `FreeTube` label before publishing. Re-running a commit keeps its version and does not replace an existing release.

Release notes use the `Description` section of the merged PR associated with each commit. Write it as concise, user-facing notes in plain language, preferably as short bullets. Keep it within F-Droid's 500-character changelog limit. For changes with no user-visible effect, use `No user-facing changes.` If a commit has no associated merged PR or its description is empty, the workflow uses the commit message instead.
