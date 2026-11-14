# Android beta PR test APKs

The `Android Beta Test APK` workflow builds a signed APK for testing. It does not create a GitHub Release or tag, and it does not advance the beta release sequence.

## Build from a pull request

After this workflow merges into `beta/0.26.0`, add the `beta-apk-test` label to a PR that targets that branch and is authored by `Gnu-Gorets`. If the label is already present, remove it and add it again to create a new label event.

The workflow builds the exact PR head commit. It adds a comment with the workflow run link. Download the APK from the run's **Artifacts** section. Artifacts expire after seven days.

The workflow rebuilds when new commits are pushed while the label remains. Remove the label to stop test builds.

## Signing access

The workflow uses the beta signing secrets. It runs only for PRs from the `Gnu-Gorets` account in this repository. The job builds PR-controlled source with the signing key, so do not broaden this gate to untrusted contributors.
