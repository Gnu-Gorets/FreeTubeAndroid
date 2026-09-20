# Android Nightly Signing Quickstart

## 1. Create nightly keystore

Run from repository root:

```bash
mkdir -p ~/private/freetube-signing
chmod 700 ~/private/freetube-signing
docker compose build android-build

docker compose run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$HOME/private/freetube-signing:/keys" \
  android-build bash -lc \
  'umask 077; keytool -genkeypair -v \
    -keystore /keys/freetube-nightly.keystore \
    -alias freetube-nightly \
    -keyalg RSA -keysize 2048 -validity 10000'
```

`keytool` asks for keystore password twice. With PKCS12, same password is used for key. Press `Enter` for certificate fields, then answer `yes` to confirmation.

`validity 10000` is approximately 27 years.

File path:

```text
~/private/freetube-signing/freetube-nightly.keystore
```

Optional verification:

```bash
docker compose run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$HOME/private/freetube-signing:/keys" \
  android-build \
  keytool -list -v -keystore /keys/freetube-nightly.keystore
```

Expected values include:

```text
Alias name: freetube-nightly
Entry type: PrivateKeyEntry
Subject Public Key Algorithm: 2048-bit RSA
```

## 2. Store backup in KeePassXC

Create entry `FreeTube Android Nightly` with:

- attachment: `freetube-nightly.keystore`;
- alias: `freetube-nightly`;
- keystore password;
- key password, same as keystore password for this PKCS12 file;
- SHA-256 certificate fingerprint;
- application ID: `io.freetubeapp.freetubeandroid.nightly`.

Keep encrypted backups of KeePassXC. Never commit keystore file.

## 3. Add GitHub Secrets

Open:

```text
Repository → Settings → Secrets and variables → Actions → New repository secret
```

Create these four repository secrets:

```text
ANDROID_NIGHTLY_KEYSTORE_BASE64
ANDROID_NIGHTLY_KEYSTORE_PASSWORD
ANDROID_NIGHTLY_KEY_ALIAS
ANDROID_NIGHTLY_KEY_PASSWORD
```

Values:

```text
ANDROID_NIGHTLY_KEYSTORE_BASE64     Base64-encoded keystore
ANDROID_NIGHTLY_KEYSTORE_PASSWORD   keystore password
ANDROID_NIGHTLY_KEY_ALIAS           freetube-nightly
ANDROID_NIGHTLY_KEY_PASSWORD        same key password
```

Generate Base64 value:

```bash
base64 ~/private/freetube-signing/freetube-nightly.keystore | tr -d '\n'
```

Copy complete output into `ANDROID_NIGHTLY_KEYSTORE_BASE64`. GitHub does not show secret values after saving.

## 4. Local unsigned release build

Keystore is not needed for local size/build checks:

```bash
docker compose run --rm android-nightly
```

Service reads version from `package.json`, adds `-nightly.local`, and builds release APK with R8/resource shrinking.

Output:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

This APK is unsigned and cannot update installed signed app.

## 5. GitHub nightly build

Every push to `development` runs same `android-nightly` Compose service. CI provides signing files and version values, so output is signed.

Pipeline behavior:

- base version comes from `package.json`;
- version is `<base-version>-nightly.<run_number>`;
- application ID is `io.freetubeapp.freetubeandroid.nightly`;
- release is published under mutable tag `nightly`;
- asset `freetube-nightly.apk` is replaced with latest build.
