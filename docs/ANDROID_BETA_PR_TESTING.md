# Android beta test APKs

The `Android Beta Test APK` workflow builds signed APKs for testing. It does not create a GitHub Release or tag. The version comes from the selected commit, so a test run does not advance the beta release sequence.

GitHub reads the workflow from the default branch for PR label events. Merge this workflow into `development` before using the label trigger.

## Build from a pull request

For a PR targeting `beta/0.26.0` and authored by `Gnu-Gorets`, add the `beta-apk-test` label. The workflow builds the PR head commit and adds a comment with the workflow run link. The APK is in the run's **Artifacts** section.

The workflow also rebuilds when new commits are pushed while the label remains. Remove the label to stop test builds.

## Build a selected branch and commit

After the workflow is merged into the default branch, run:

```bash
gh workflow run android-beta-pr-test.yml \
  --repo Gnu-Gorets/FreeTubeAndroid \
  --ref development \
  -f source_branch=beta/0.26.0-port \
  -f commit_sha=FULL_COMMIT_SHA
```

`--ref development` selects the workflow definition. `source_branch` and `commit_sha` select the source branch and exact commit. The workflow rejects commits outside that branch or before `v0.26.0-beta`.

Find the workflow run and download its APK artifact:

```bash
gh run list \
  --repo Gnu-Gorets/FreeTubeAndroid \
  --workflow android-beta-pr-test.yml \
  --limit 5

gh run download RUN_ID \
  --repo Gnu-Gorets/FreeTubeAndroid \
  --name freetube-android-beta-test-SHORT_SHA
```

Artifacts expire after seven days. The workflow uses the same commit-based version as a normal beta release build. It does not reserve a version or publish an APK as a Release.

## Signing access

The workflow uses the beta signing secrets. It runs only for PRs from the `Gnu-Gorets` account in this repository, or manual dispatches by that account. The job builds PR-controlled source with the signing key, so do not broaden this gate to untrusted contributors.
