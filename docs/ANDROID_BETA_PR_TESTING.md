# Android beta PR test APKs

The `Android Beta Test APK` workflow builds a signed APK for testing. For a labeled pull request, it publishes the APK to a dedicated prerelease and tag for that PR. This does not advance the official beta release sequence.

## Build from a pull request

After this workflow merges into `beta/0.26.0`, add the `beta-apk-test` label to a PR that targets that branch and is authored by `Gnu-Gorets`. If the label is already present, remove it and add it again to create a new label event.

The workflow builds the exact PR head commit. It adds a comment with a direct APK download link. Each PR has one test prerelease, tagged `android-beta-apk-test-pr-<PR number>`. A successful rebuild replaces that release's APK and moves its tag to the tested commit. The release remains after the label is removed or the PR is closed; only the latest successfully published APK is kept.

The workflow rebuilds when new commits are pushed while the label remains. Remove the label to stop test builds. Manual workflow runs do not publish a release.

## Signing access

The workflow uses the beta signing secrets. It runs only for PRs from the `Gnu-Gorets` account in this repository. The job builds PR-controlled source with the signing key, so do not broaden this gate to untrusted contributors.
