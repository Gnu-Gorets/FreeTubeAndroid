# Android release via F-Droid

Publish Android release source tag on GitHub. F-Droid builds and signs APK. Do not publish separate APK signed by project.

## Release steps

### 1. Start release branch from upstream

Choose upstream FreeTube release and list Android commits from `development` that are required for this release. Do not merge the whole `development` branch.

```bash
git fetch upstream --tags
git switch --detach vX.Y.Z
git switch -c release/vX.Y.Z
```

Replace `vX.Y.Z` with upstream tag. Cherry-pick only reviewed Android commits, oldest first:

```bash
git cherry-pick <commit-1> <commit-2>
```

Resolve conflicts and test the resulting branch. If required Android changes are not separable into commits, identify the complete intended change set before proceeding.

### 2. Set version and validate

Set `androidVersionName` and `androidVersionCode` higher than previous F-Droid release for `io.freetubeapp.freetubeandroid`. Gradle defaults `0.1.0-local` and `1` are for local builds, not releases. Record upstream tag, selected commits, final fork commit, version name, and version code.

Run the normal Docker build and checks from [Development workflow](DEVELOPMENT.md). For a release build check, pass release values explicitly:

```bash
docker compose run --rm android-build bash -lc \
  'pnpm install --frozen-lockfile && pnpm run pack:android:core && \
   cd android && ./gradlew clean assembleRelease \
     -PandroidVersionName=VERSION_NAME \
     -PandroidVersionCode=VERSION_CODE'
```

This is a build validation only. Do not publish the locally generated APK.

### 3. Tag and publish source on GitHub

Commit any release-only fixes on `release/vX.Y.Z`, then tag the final commit with a fork-specific tag, for example `android-vX.Y.Z.1`. Push the branch and tag to `origin`, then create a GitHub Release for that tag with a short changelog and the upstream base version. GitHub provides source archive automatically. Do not attach APK.

```bash
git push -u origin release/vX.Y.Z
git tag -a android-vX.Y.Z.1 -m "FreeTubeAndroid X.Y.Z.1"
git push origin android-vX.Y.Z.1
```

Never move or reuse a published tag. If a release needs a fix, make a new commit and new tag.

### 4. Submit to F-Droid

Submit a merge request to [fdroiddata](https://gitlab.com/fdroid/fdroiddata), pinned to the fork tag, with required source build steps and version code. For first inclusion, follow the [F-Droid submission guide](https://fdroid.gitlab.io/jekyll-fdroid/docs/Submitting_to_F-Droid_Quick_Start_Guide/). This is a metadata merge request, not a request to upload an APK. Check [inclusion policy](https://f-droid.org/docs/Inclusion_Policy/) and test recipe with F-Droid tooling where possible. For an existing app, add the new tag as a new build entry and submit the metadata update.

Address review or build issues. If source code must change, publish a new fork tag and update the merge request to that tag. Wait for F-Droid publication. GitHub Release may be available first; state actual F-Droid status and add listing link when it exists.

## Keep it simple

- F-Droid signs distributed APK. Do not create or upload stable project signing key or APK.
- GitHub hosts immutable source tag, changelog, and release notes. It is not second APK channel.
- Users install and update through F-Droid. Cross signature or manual channel switching instructions are not needed.
- F-Droid review and publication take time. GitHub Release does not mean version is already available in F-Droid client.
- Project does not guarantee reproducible APKs byte for byte. Do not claim reproducibility without checking actual F-Droid build.
