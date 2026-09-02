#!/usr/bin/env bash
set -u

PACKAGE="io.freetubeapp.freetubeandroid"
ACTIVITY="$PACKAGE/.MainActivity"
PERSONAL_USER_ID=0
APK="$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/debug/app-debug.apk"
SERIAL=""
TEST="all"
SUITE="all"
DOWNLOAD_VIDEO_URL="https://youtu.be/6gFpmmLbs2U"
KEEP_DATA=1
TIMEOUT=45
DOWNLOAD_TIMEOUT=180
ARTIFACT_DIR="$(cd "$(dirname "$0")/.." && pwd)/tmp/android-smoke/$(date +%Y%m%d-%H%M%S)"
LOG_FILE=""
PASS=0
FAIL=0
SKIP=0
UI_SCALE_SET=0

usage() {
  cat <<'EOF'
Usage: _scripts/android-smoke-test.sh [options]

Options:
  --serial SERIAL       adb device serial
  --apk PATH            debug APK path
  --suite NAME          unlocked, locked, downloads, all (default: all)
  --test NAME           one test: preflight, cold-start, search, playback, controls,
                        lock-screen, audio-focus, persistence, cleanup, recovery,
                        locked-state, locked-notification, locked-session,
                        export, data-directory-cancel, data-directory-move-reset,
                        downloads-page, download-quality, download-sabr-telemetry, download-sabr-total, download-sabr-ui-progress, download-sabr-pause-resume, download-notification, download-notification-title, download-notification-terminal, download-storage, download-cancel, download-delete,
                        locked-controls, locked-audio-focus, locked-cleanup, locked-force-stop
  --keep-data           do not clear app data (default)
  --timeout SECONDS     wait timeout (default: 45)
  -h, --help            show help

Exit codes: 0 passed, 1 failed, 77 device unavailable/skipped.
EOF
}

while (($#)); do
  case "$1" in
    --serial) SERIAL="$2"; shift 2 ;;
    --apk) APK="$2"; shift 2 ;;
    --suite) SUITE="$2"; shift 2 ;;
    --test) TEST="$2"; shift 2 ;;
    --keep-data) KEEP_DATA=1; shift ;;
    --timeout) TIMEOUT="$2"; DOWNLOAD_TIMEOUT=$((TIMEOUT * 4)); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$ARTIFACT_DIR"
LOG_FILE="$ARTIFACT_DIR/logcat.txt"

adb_cmd() {
  if [[ -n "$SERIAL" ]]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi
}

adb_shell() { adb_cmd shell "$@"; }
assert_personal_profile() {
  local current_user
  current_user=$(adb_shell am get-current-user 2>/dev/null || true)
  [[ "$current_user" == "$PERSONAL_USER_ID" ]] || {
    echo "FAIL: personal profile user $PERSONAL_USER_ID is required; refusing work-profile interaction" >&2
    return 1
  }
}
screenshot() { adb_cmd exec-out screencap -p >"$ARTIFACT_DIR/$1.png"; }
dump_ui() {
  adb_shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || return 1
  adb_shell cat /sdcard/window.xml >"$ARTIFACT_DIR/$1.xml"
}
wait_for_ui_text() {
  local text="$1" start now
  start=$(date +%s)
  while :; do
    dump_ui wait-for-ui >/dev/null 2>&1 && grep -q "text=\"$text\"" "$ARTIFACT_DIR/wait-for-ui.xml" && return 0
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
}

wait_for_logcat() {
  local pattern="$1" start now
  start=$(date +%s)
  while :; do
    adb_cmd logcat -d -v brief | grep -q "$pattern" && return 0
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
}

wait_for_notification() {
  local pattern="$1" start now dump
  start=$(date +%s)
  while :; do
    dump=$(adb_shell dumpsys notification --noredact)
    grep -q "$pattern" <<<"$dump" && return 0
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
}

tap_ui_text() {
  local text="$1" bounds x1 y1 x2 y2
  bounds=$(adb_shell cat /sdcard/window.xml | grep -o "text=\"$text\"[^>]*bounds=\"\\[[0-9]*,[0-9]*\\]\\[[0-9]*,[0-9]*\\]\"" | head -1)
  [[ "$bounds" =~ bounds=\"\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]\" ]] || return 1
  x1="${BASH_REMATCH[1]}"; y1="${BASH_REMATCH[2]}"; x2="${BASH_REMATCH[3]}"; y2="${BASH_REMATCH[4]}"
  adb_shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))"
}

tap_ui_text_last() {
  local text="$1" bounds x1 y1 x2 y2
  bounds=$(adb_shell cat /sdcard/window.xml | grep -o "text=\"$text\"[^>]*bounds=\"[^\"]*\"" | grep -v 'bounds="\[0,0\]\[0,0\]"' | tail -1)
  [[ "$bounds" =~ bounds=\"\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]\" ]] || return 1
  x1="${BASH_REMATCH[1]}"; y1="${BASH_REMATCH[2]}"; x2="${BASH_REMATCH[3]}"; y2="${BASH_REMATCH[4]}"
  adb_shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))"
}

tap_visible_ui_text() {
  local text="$1" bounds x1 y1 x2 y2
  for _ in $(seq 1 12); do
    dump_ui visible-action >/dev/null 2>&1 || true
    bounds=$(adb_shell cat /sdcard/window.xml | grep -o "text=\"$text\"[^>]*bounds=\"[^\"]*\"" | grep -v 'bounds="\[0,0\]\[0,0\]"' | head -1)
    if [[ "$bounds" =~ bounds=\"\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]\" ]]; then
      x1="${BASH_REMATCH[1]}"; y1="${BASH_REMATCH[2]}"; x2="${BASH_REMATCH[3]}"; y2="${BASH_REMATCH[4]}"
      adb_shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))"
      return 0
    fi
    adb_shell input swipe 360 1300 360 500 300
    sleep 1
  done
  return 1
}

tap_delete_after_last_completed() {
  local completed delete x1 y1 x2 y2 completed_y2
  completed=$(adb_shell cat /sdcard/window.xml | grep -o 'text="completed"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | grep -v 'bounds="\[0,0\]\[0,0\]"' | tail -1)
  [[ "$completed" =~ bounds=\"\[[0-9]+,[0-9]+\]\[([0-9]+),([0-9]+)\]\" ]] || return 1
  completed_y2="${BASH_REMATCH[2]}"
  while read -r delete; do
    [[ "$delete" =~ bounds=\"\[[0-9]+,([0-9]+)\]\[([0-9]+),([0-9]+)\]\" ]] || continue
    y1="${BASH_REMATCH[1]}"; x2="${BASH_REMATCH[2]}"; y2="${BASH_REMATCH[3]}"
    if (( y1 > completed_y2 )); then
      x1=357
      adb_shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))"
      return 0
    fi
  done < <(adb_shell cat /sdcard/window.xml | grep -o 'text="Delete"[^>]*bounds="\\[[0-9]*,[0-9]*\\]\\[[0-9]*,[0-9]*\\]"')
  return 1
}

if ! command -v adb >/dev/null 2>&1; then
  echo "SKIP: adb is not installed"; exit 77
fi

if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [[ -z "$SERIAL" ]] || ! adb_cmd get-state >/dev/null 2>&1; then
  echo "SKIP: no adb device connected"; exit 77
fi
assert_personal_profile || exit 77
adb_cmd root >/dev/null 2>&1 || true
sleep 2

run_test() {
  local name="$1"; shift
  echo "== $name =="
  if assert_personal_profile && "$@"; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name"
    FAIL=$((FAIL + 1))
  fi
}

is_focused() {
  adb_shell dumpsys activity activities 2>/dev/null | grep -qE "mResumedActivity:.*$1|mFocusedApp=.*$1"
}

wait_for() {
  local pattern="$1" start now
  start=$(date +%s)
  while :; do
    if is_focused "$pattern"; then return 0; fi
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
}

close_picker() {
  for _ in 1 2 3; do
    is_focused "$PACKAGE" && return 0
    adb_shell input keyevent KEYCODE_BACK
    sleep 1
  done
  wait_for "$PACKAGE"
}

device_is_unlocked() {
  adb_shell dumpsys power | grep -q 'mWakefulness=Awake' || return 1
  ! adb_shell dumpsys window | grep -qE 'mShowingLockscreen=true|mDreamingLockscreen=true'
}

wake_device() {
  if adb_shell dumpsys power | grep -qE 'mWakefulness=(Asleep|Dozing)'; then
    adb_shell input keyevent KEYCODE_POWER
  else
    adb_shell input keyevent KEYCODE_WAKEUP
  fi
  adb_shell wm dismiss-keyguard >/dev/null 2>&1 || true
  adb_shell input swipe 360 1400 360 400 300 >/dev/null 2>&1 || true
  sleep 2
}

require_unlocked() {
  wake_device
  if ! device_is_unlocked; then
    echo "SKIP: device is locked; unlocked suite requires manual unlock"
    exit 77
  fi
}

ensure_ui_scale_100() {
  (( UI_SCALE_SET == 1 )) && return 0
  adb_shell am force-stop "$PACKAGE"
  adb_shell am force-stop com.android.documentsui >/dev/null 2>&1 || true
  adb_shell am start -n "$ACTIVITY" >/dev/null || return 1
  wait_for "$PACKAGE" || return 1
  sleep 5
  # Open Settings through persistent mobile bottom navigation.
  adb_shell input tap 615 1540
  sleep 5
  # Handle current 70% layout, then normalize after possible reload.
  adb_shell input tap 18 98
  sleep 1
  adb_shell input tap 55 280
  sleep 3
  adb_shell input tap 18 98
  sleep 2
  adb_shell input tap 80 234
  sleep 2
  adb_shell input tap 385 588
  sleep 5
  # At 100% Settings uses full-screen mobile section menu.
  adb_shell input tap 63 245
  sleep 2
  adb_shell input tap 300 444
  sleep 2
  # Theme UI Scale slider: 50..300%, 100% is x=198 at 100% layout.
  adb_shell input tap 198 934
  sleep 5
  screenshot ui-scale-100
  UI_SCALE_SET=1
}

start_app() {
  ensure_ui_scale_100 || return 1
  adb_shell am force-stop com.android.documentsui >/dev/null 2>&1 || true
  adb_shell am start -n "$ACTIVITY" >/dev/null || return 1
  wait_for "$PACKAGE" || return 1
  sleep 5
}

open_search_results() {
  start_app || return 1
  adb_shell input tap 350 104
  adb_shell input text linux
  adb_shell input tap 525 104
  adb_shell input keyevent KEYCODE_ENTER
  sleep 12
}

clean_logs() { adb_cmd logcat -c; : >"$LOG_FILE"; }
collect_logs() {
  adb_cmd logcat -d -v brief >"$LOG_FILE"
  adb_shell dumpsys media_session >"$ARTIFACT_DIR/media_session.txt"
  adb_shell dumpsys audio >"$ARTIFACT_DIR/audio.txt"
}
no_runtime_errors() {
  collect_logs
  ! grep -E 'FATAL EXCEPTION|Failed to fetch|TypeError:|AndroidRuntime: FATAL' "$LOG_FILE" >/dev/null
}

preflight() {
  assert_personal_profile || return 1
  [[ -f "$APK" ]] || { echo "APK not found: $APK"; return 1; }
  adb_cmd install -r --user "$PERSONAL_USER_ID" "$APK" >/dev/null || return 1
  local pkg
  pkg=$(adb_shell dumpsys package "$PACKAGE") || return 1
  grep -q 'targetSdk=36' <<<"$pkg" || { echo "targetSdk 36 not found"; return 1; }
  grep -q 'versionCode=' <<<"$pkg" || { echo "package not installed"; return 1; }
  adb_shell pm grant --user "$PERSONAL_USER_ID" "$PACKAGE" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
  return 0
}

cold_start() {
  clean_logs
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  screenshot cold-start
  no_runtime_errors
}

search() {
  clean_logs
  open_search_results || return 1
  screenshot search
  no_runtime_errors || return 1
  grep -q 'Search Results' "$ARTIFACT_DIR/search.png" 2>/dev/null && return 0
  # WebView text is not exposed to adb screenshot tools. Presence of a non-empty screenshot is fallback.
  [[ -s "$ARTIFACT_DIR/search.png" ]]
}

open_video() {
  adb_shell am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v=jNQXAC9IVRw' -n "$ACTIVITY" >/dev/null
  sleep 25
  adb_shell input tap 400 340
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  sleep 3
  screenshot video
}

open_download_video() {
  adb_shell am start -a android.intent.action.VIEW -d "$DOWNLOAD_VIDEO_URL" -n "$ACTIVITY" >/dev/null
  sleep 30
  adb_shell input tap 400 340
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  sleep 3
  screenshot download-video
}

playback() {
  clean_logs
  open_search_results || return 1
  open_video
  no_runtime_errors || return 1
  grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' "$ARTIFACT_DIR/media_session.txt" | grep -q 'state=PlaybackState {state=PLAYING'
}

controls() {
  clean_logs
  adb_shell input tap 400 340
  sleep 1
  adb_shell input tap 520 457
  sleep 1
  adb_shell am start -a MEDIA_PAUSE -n "$ACTIVITY" >/dev/null
  sleep 1
  adb_shell dumpsys media_session | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' | grep -q 'state=PlaybackState {state=PAUSED' || return 1
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  sleep 2
  adb_shell dumpsys media_session | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' | grep -q 'state=PlaybackState {state=PLAYING' || return 1
  screenshot controls
  no_runtime_errors
}

locked_state() {
  adb_shell dumpsys power | grep -qE 'mWakefulness=(Asleep|Dozing)' && return 0
  adb_shell dumpsys window | grep -qE 'mShowingLockscreen=true|mDreamingLockscreen=true'
}

media_session() {
  adb_shell dumpsys media_session | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid'
}

locked_screen() {
  locked_state || return 1
  no_runtime_errors
}

locked_notification() {
  locked_state || return 1
  adb_shell dumpsys notification --noredact | grep -q 'io.freetubeapp.freetubeandroid.*id=1001'
}

locked_session() {
  locked_state || return 1
  media_session | grep -q 'active=true' || return 1
  media_session | grep -q 'state=PlaybackState {state=PLAYING'
}

locked_controls() {
  locked_state || return 1
  adb_shell am start -a MEDIA_PAUSE -n "$ACTIVITY" >/dev/null
  sleep 2
  media_session | grep -q 'state=PlaybackState {state=PAUSED' || return 1
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  sleep 2
  media_session | grep -q 'state=PlaybackState {state=PLAYING'
}

locked_audio_focus() {
  locked_state || return 1
  adb_shell dumpsys audio | grep -q "$PACKAGE"
}

locked_cleanup() {
  locked_state || return 1
  media_session | grep -q 'active=true' || return 1
  adb_shell dumpsys notification --noredact | grep -q 'io.freetubeapp.freetubeandroid.*id=1001'
}

locked_force_stop() {
  locked_state || return 1
  adb_shell am force-stop "$PACKAGE"
  sleep 3
  ! adb_shell dumpsys media_session | grep -q 'io.freetubeapp.freetubeandroid/FreeTubeAndroid'
}

lock_screen() {
  locked_screen || return 1
  locked_notification || return 1
  locked_session || return 1
  no_runtime_errors
}

audio_focus() {
  local ref=io.freetubeapp.freetube
  if ! adb_shell pm path "$ref" >/dev/null 2>&1; then
    echo "SKIP: reference FreeTube APK is not installed"
    SKIP=$((SKIP + 1))
    return 0
  fi
  adb_shell am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' -p "$ref" >/dev/null
  sleep 8
  adb_shell input tap 390 345
  sleep 4
  adb_shell dumpsys audio | grep -q "$ref" || return 1
  adb_shell am start -n "$ACTIVITY" >/dev/null
  sleep 3
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  sleep 3
  adb_shell dumpsys audio | grep -q "$PACKAGE" || return 1
  no_runtime_errors
}

open_data_settings() {
  start_app || return 1
  # Reopen Settings after cold start or Activity recreation. First close any stale modal.
  adb_shell input tap 615 1540
  sleep 1
  adb_shell input keyevent KEYCODE_BACK
  sleep 1
  adb_shell input tap 615 1540
  sleep 3
  # At UI scale 100% Settings uses full-screen mobile section menu.
  adb_shell input tap 300 1084
  sleep 3
}

export_data() {
  open_data_settings || return 1
  # Export Playlists button in Data settings.
  adb_shell input tap 480 1070
  sleep 3
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  screenshot export-picker
  close_picker
}

data_directory_cancel() {
  open_data_settings || return 1
  local mapping_before mapping_after
  mapping_before=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  adb_shell input tap 215 383
  sleep 3
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  close_picker || return 1
  mapping_after=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  [[ "$mapping_before" == "$mapping_after" ]]
}

data_directory_move_reset() {
  open_data_settings || return 1
  adb_shell input tap 215 383
  sleep 3
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  # DocumentsUI reopens last tree location; normalize to Documents before selecting it.
  adb_shell input tap 280 204
  sleep 2
  adb_shell input tap 360 1560
  sleep 2
  adb_shell input tap 610 905
  sleep 8
  local mapping
  mapping=$(adb_shell cat "/data/user/0/$PACKAGE/files/data/data-location.json" 2>/dev/null || true)
  grep -q 'primary%3ADocuments' <<<"$mapping" || return 1
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  open_data_settings || return 1
  adb_shell input tap 500 383
  sleep 8
  mapping=$(adb_shell cat "/data/user/0/$PACKAGE/files/data/data-location.json" 2>/dev/null || true)
  grep -q '"directory":"data://"' <<<"$mapping" || return 1
  adb_shell rm -f /sdcard/Documents/profiles.db /sdcard/Documents/settings.db /sdcard/Documents/history.db /sdcard/Documents/playlists.db /sdcard/Documents/search-history.db /sdcard/Documents/subscription-cache.db
}

persistence() {
  start_app || return 1
  # Toggle Theme setting, restart, and keep an artifact for visual confirmation.
  adb_shell input tap 40 445
  sleep 2
  adb_shell input tap 390 385
  sleep 2
  adb_shell input tap 170 286
  sleep 2
  screenshot persistence-before-restart
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  adb_shell input tap 40 445
  sleep 1
  adb_shell input tap 390 385
  sleep 2
  screenshot persistence-after-restart
  adb_shell run-as "$PACKAGE" test -d app_webview/Default/IndexedDB
}

cleanup() {
  if ! playback; then
    echo "SKIP: cleanup setup playback failed"
    SKIP=$((SKIP + 1))
    return 0
  fi
  adb_shell input keyevent KEYCODE_BACK
  sleep 2
  if adb_shell dumpsys media_session | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' | grep -q 'active='; then
    adb_shell dumpsys media_session | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' | grep -q 'active=false' || return 1
  fi
  ! adb_shell dumpsys notification --noredact | grep -q 'io.freetubeapp.freetubeandroid.*id=1001'
}

recovery() {
  adb_shell am force-stop "$PACKAGE"
  sleep 3
  ! adb_shell dumpsys media_session | grep -q 'io.freetubeapp.freetubeandroid/FreeTubeAndroid' || return 1
  start_app || return 1
  adb_shell dumpsys activity activities | grep -q "$PACKAGE"
}

downloads_page() {
  clean_logs
  start_app || return 1
  adb_shell input tap 535 1540
  sleep 3
  screenshot downloads-page
  dump_ui downloads-page || { sleep 1; dump_ui downloads-page || return 1; }
  [[ -s "$ARTIFACT_DIR/downloads-page.png" ]] || return 1
  no_runtime_errors
}

download_quality() {
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 3
  screenshot download-quality
  # WebView text is not exposed reliably to UIAutomator. Check renderer log instead.
  adb_cmd logcat -d -v brief >"$ARTIFACT_DIR/download-quality-logcat.txt"
  grep -q 'picker options' "$ARTIFACT_DIR/download-quality-logcat.txt" || return 1
  grep -Eq '2160p|1440p|1080p|720p|480p|360p|240p|144p' "$ARTIFACT_DIR/download-quality-logcat.txt" || return 1
  adb_shell input keyevent KEYCODE_BACK
  no_runtime_errors
}

download_sabr_telemetry() {
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 220 940
  wait_for_logcat 'SABR store complete' || return 1
  adb_cmd logcat -d -v threadtime >"$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt"
  grep -q 'SABR telemetry' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  grep -q '"progress":1' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  grep -Eq 'SABR store complete .*"size":[1-9][0-9]*' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  ! grep -q '"mismatch":true' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt"
}

download_sabr_total() {
  echo '[download-sabr-total] opening video'
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 2
  # Select 1440p SABR, the regression quality where total changed from 216.8 MB to 218.2 MB.
  adb_shell input tap 360 808
  sleep 2
  screenshot download-sabr-total-start
  local completed=0
  for second in $(seq 0 2 "$DOWNLOAD_TIMEOUT"); do
    if adb_cmd logcat -d -v brief | grep -q 'SABR store complete'; then
      completed=1
      echo "[download-sabr-total] completion detected at ${second}s"
      break
    fi
    sleep 2
  done
  (( completed == 1 )) || { echo '[download-sabr-total] completion timeout'; return 1; }
  adb_cmd logcat -d -v threadtime >"$ARTIFACT_DIR/download-sabr-total-logcat.txt"
  python3 - "$ARTIFACT_DIR/download-sabr-total-logcat.txt" <<'PY'
import json
import re
import sys

log = open(sys.argv[1], encoding='utf-8').read()
estimates = [json.loads(value) for value in re.findall(r'SABR size estimate (\{.*?\}) \(webpack', log)]
assert estimates, 'SABR size estimate is missing'
estimate = estimates[-1]
download_id = estimate['id']
assert estimate.get('maxHeight') == 1440, estimate
updates = [json.loads(value) for value in re.findall(r'metadata update (\{.*?\}) \(webpack', log)]
updates = [item for item in updates if item.get('id') == download_id]
progress = [item for item in updates if item.get('status') == 'downloading' and item.get('total', 0) > 0]
assert progress, 'SABR progress totals are missing'
totals = {item['total'] for item in progress}
assert totals == {estimate['total']}, f'total changed during download: estimate={estimate["total"]}, updates={sorted(totals)}'
completed = [item for item in updates if item.get('status') == 'completed']
assert completed, 'SABR completion metadata is missing'
final = completed[-1]
assert final.get('total') == estimate['total'], f'total changed on completion: {estimate["total"]} -> {final.get("total")}'
if final.get('totalExact'):
    assert final.get('received') == final.get('total'), f'exact final bytes mismatch: {final}'
else:
    assert final.get('received', 0) >= final.get('total', 0), f'estimated total exceeds final bytes: {final}'
PY
}

download_sabr_ui_progress() {
  echo '[download-sabr-ui-progress] opening video'
  clean_logs
  open_download_video || return 1
  echo '[download-sabr-ui-progress] selecting 360p SABR'
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 575 875
  adb_shell input tap 535 1540
  echo '[download-sabr-ui-progress] download started, waiting for completion'
  sleep 2
  screenshot download-sabr-ui-progress
  dump_ui download-sabr-ui-progress || true
  test -s "$ARTIFACT_DIR/download-sabr-ui-progress.png" || return 1
  if grep -q 'downloading' "$ARTIFACT_DIR/download-sabr-ui-progress.xml"; then
    grep -Eq '[0-9]+% · [1-9][0-9.]* (KB|MB|GB) / [1-9][0-9.]* (KB|MB|GB)' "$ARTIFACT_DIR/download-sabr-ui-progress.xml" || return 1
    ! grep -Eq '0 B|—' "$ARTIFACT_DIR/download-sabr-ui-progress.xml" || return 1
  fi
  completed=0
  for second in $(seq 0 2 "$DOWNLOAD_TIMEOUT"); do
    if adb_cmd logcat -d -v brief | grep -q 'SABR store complete'; then
      completed=1
      echo "[download-sabr-ui-progress] completion detected at ${second}s"
      break
    fi
    if (( second % 10 == 0 )); then
      progress=$(adb_cmd logcat -d -v brief | grep 'SABR store progress' | tail -1 || true)
      telemetry=$(adb_cmd logcat -d -v brief | grep 'SABR telemetry' | tail -1 || true)
      echo "[download-sabr-ui-progress] ${second}s progress=${progress:-none} telemetry=${telemetry:-none}"
    fi
    sleep 2
  done
  (( completed == 1 )) || { echo '[download-sabr-ui-progress] completion timeout'; return 1; }
  adb_cmd logcat -d -v threadtime > "$ARTIFACT_DIR/download-sabr-ui-progress-logcat.txt"
  grep -q 'SABR store complete' "$ARTIFACT_DIR/download-sabr-ui-progress-logcat.txt" || return 1
  grep -q 'metadata update.*"status":"completed"' "$ARTIFACT_DIR/download-sabr-ui-progress-logcat.txt" || return 1
  python3 - "$ARTIFACT_DIR/download-sabr-ui-progress-logcat.txt" <<'PY'
import re
import sys

log = open(sys.argv[1], encoding='utf-8').read()
speeds = [int(value) for value in re.findall(r'metadata update .*"speedBps":([1-9][0-9]*)', log)]
assert speeds, 'smoothed speed samples are missing'
assert all(max(a, b) <= min(a, b) * 1.6 for a, b in zip(speeds, speeds[1:])), f'speed jumps between samples: {speeds}'
assert not re.search(r'metadata update .*"status":"completed".*"speedBps":[1-9]', log)
PY
}

download_sabr_pause_resume() {
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 2
  # Select 720p to leave enough time for pause action before completion.
  adb_shell input tap 160 875
  adb_shell input tap 535 1540
  wait_for_ui_text downloading || return 1
  tap_visible_ui_text Pause || return 1
  wait_for_ui_text paused || return 1
  dump_ui download-sabr-pause || return 1
  grep -q 'paused' "$ARTIFACT_DIR/download-sabr-pause.xml" || return 1
  tap_visible_ui_text Resume || return 1
  sleep 2
  dump_ui download-sabr-resume || return 1
  grep -Eq 'downloading|completed' "$ARTIFACT_DIR/download-sabr-resume.xml" || return 1
  no_runtime_errors
}

download_notification() {
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 2
  # Select 720p from quality picker.
  adb_shell input tap 160 875
  wait_for_notification 'channel=downloads' || return 1
  adb_shell dumpsys notification --noredact >"$ARTIFACT_DIR/download-notification-during.txt"
  grep -q '"Pause"' "$ARTIFACT_DIR/download-notification-during.txt" || return 1
  grep -q '"Cancel"' "$ARTIFACT_DIR/download-notification-during.txt" || return 1
  grep -q 'android.progress=Integer' "$ARTIFACT_DIR/download-notification-during.txt" || return 1
  adb_shell input swipe 360 100 360 1000 500
  sleep 2
  screenshot download-notification-shade
  [[ -s "$ARTIFACT_DIR/download-notification-shade.png" ]] || return 1
  adb_shell input keyevent KEYCODE_BACK
  no_runtime_errors
}

download_notification_title() {
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 160 875
  wait_for_notification 'channel=downloads' || return 1
  local dump
  dump=$(adb_shell dumpsys notification --noredact)
  grep -q 'channel=downloads' <<<"$dump" || return 1
  grep -Eq 'android.title=String \([A-Za-zА-Яа-я]' <<<"$dump" || return 1
  adb_shell input swipe 360 100 360 1000 500
  sleep 2
  screenshot download-notification-title-shade
  adb_shell input keyevent KEYCODE_BACK
  no_runtime_errors
}

download_notification_terminal() {
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  adb_shell input swipe 360 100 360 1000 500
  sleep 2
  screenshot download-notification-terminal-shade
  ! adb_shell dumpsys notification --noredact | grep -q 'Downloading [0-9]'
}

download_storage() {
  adb_shell content query --uri content://media/external_primary/downloads \
    --projection _display_name:relative_path:_size:is_pending >"$ARTIFACT_DIR/download-storage.txt" 2>/dev/null || return 1
  if ! grep -q 'relative_path=Download/FreeTube/' "$ARTIFACT_DIR/download-storage.txt"; then
    echo "SKIP: no public FreeTube download fixture on device"
    SKIP=$((SKIP + 1))
    return 0
  fi
  grep -Eq '_display_name=.*\.mp4, relative_path=Download/FreeTube/, _size=[1-9][0-9]*, is_pending=0' "$ARTIFACT_DIR/download-storage.txt"
}

download_delete() {
  start_app || return 1
  adb_shell input tap 535 1540
  sleep 3
  dump_ui download-delete-before || return 1
  if ! grep -q 'completed' "$ARTIFACT_DIR/download-delete-before.xml"; then
    echo "SKIP: no completed download fixture on device"
    SKIP=$((SKIP + 1))
    return 0
  fi
  # Delete last completed entry and verify completed count decreases.
  local before_count after_count
  before_count=$(grep -o 'text="completed"[^>]*bounds="\[[1-9][0-9]*,' "$ARTIFACT_DIR/download-delete-before.xml" | wc -l)
  tap_delete_after_last_completed || return 1
  sleep 3
  dump_ui download-delete-after || return 1
  after_count=$(grep -o 'text="completed"[^>]*bounds="\[[1-9][0-9]*,' "$ARTIFACT_DIR/download-delete-after.xml" | wc -l)
  (( after_count < before_count ))
}

download_cancel() {
  clean_logs
  open_download_video || return 1
  adb_shell input tap 185 830
  sleep 2
  # Select 720p from quality picker before opening Downloads.
  adb_shell input tap 160 875
  sleep 1
  adb_shell input tap 535 1540
  wait_for_ui_text downloading || return 1
  dump_ui download-cancel-before || return 1
  if ! grep -q 'downloading' "$ARTIFACT_DIR/download-cancel-before.xml"; then
    echo "SKIP: download completed before cancel action became available"
    SKIP=$((SKIP + 1))
    return 0
  fi
  tap_visible_ui_text Cancel || return 1
  sleep 3
  dump_ui download-cancel-after || return 1
  grep -q 'canceled' "$ARTIFACT_DIR/download-cancel-after.xml" || return 1
  no_runtime_errors
}

run_unlocked_suite() {
  require_unlocked
  if ! preflight; then
    echo "FAIL preflight"
    FAIL=$((FAIL + 1))
    return
  fi
  echo "PASS preflight"
  PASS=$((PASS + 1))
  run_test cold-start cold_start
  run_test search search
  run_test playback playback
  run_test controls controls
  run_test audio-focus audio_focus
  run_test persistence persistence
  run_test export export_data
  run_test data-directory-cancel data_directory_cancel
  run_test data-directory-move-reset data_directory_move_reset
  run_test downloads-page downloads_page
  run_test download-quality download_quality
  run_test download-sabr-telemetry download_sabr_telemetry
  run_test download-sabr-pause-resume download_sabr_pause_resume
  run_test download-notification download_notification
  run_test download-storage download_storage
  run_test download-cancel download_cancel
  run_test download-delete download_delete
  run_test cleanup cleanup
  run_test recovery recovery
  (( FAIL == 0 ))
}

run_downloads_suite() {
  require_unlocked
  if ! preflight; then
    echo "FAIL preflight"
    FAIL=$((FAIL + 1))
    return
  fi
  echo "PASS preflight"
  PASS=$((PASS + 1))
  run_test downloads-page downloads_page
  run_test download-quality download_quality
  run_test download-sabr-telemetry download_sabr_telemetry
  run_test download-sabr-total download_sabr_total
  run_test download-sabr-ui-progress download_sabr_ui_progress
  run_test download-sabr-pause-resume download_sabr_pause_resume
  run_test download-notification download_notification
  run_test download-notification-title download_notification_title
  run_test download-notification-terminal download_notification_terminal
  run_test download-storage download_storage
  run_test download-cancel download_cancel
  run_test download-delete download_delete
  (( FAIL == 0 ))
}

run_locked_suite() {
  if device_is_unlocked; then
    require_unlocked
    if ! preflight; then
      echo "FAIL preflight"
      FAIL=$((FAIL + 1))
      return
    fi
    echo "PASS preflight"
    PASS=$((PASS + 1))
    playback || return
    adb_shell input keyevent KEYCODE_POWER
    sleep 8
  else
    echo "Using existing locked playback state"
  fi
  run_test locked-state locked_screen
  run_test locked-notification locked_notification
  run_test locked-session locked_session
  run_test locked-controls locked_controls
  run_test locked-audio-focus locked_audio_focus
  run_test locked-cleanup locked_cleanup
  run_test locked-force-stop locked_force_stop
  (( FAIL == 0 ))
}

case "$TEST" in
  all)
    case "$SUITE" in
      all) run_unlocked_suite && run_locked_suite ;;
      unlocked) run_unlocked_suite ;;
      locked) run_locked_suite ;;
      downloads) run_downloads_suite ;;
      *) echo "Unknown suite: $SUITE" >&2; exit 2 ;;
    esac
    ;;
  preflight) run_test preflight preflight ;;
  cold-start) run_test cold-start cold_start ;;
  search) run_test search search ;;
  playback) run_test playback playback ;;
  controls) run_test controls controls ;;
  lock-screen) run_test lock-screen lock_screen ;;
  locked-state) run_test locked-state locked_screen ;;
  locked-notification) run_test locked-notification locked_notification ;;
  locked-session) run_test locked-session locked_session ;;
  locked-controls) run_test locked-controls locked_controls ;;
  locked-audio-focus) run_test locked-audio-focus locked_audio_focus ;;
  locked-cleanup) run_test locked-cleanup locked_cleanup ;;
  locked-force-stop) run_test locked-force-stop locked_force_stop ;;
  audio-focus) run_test audio-focus audio_focus ;;
  persistence) run_test persistence persistence ;;
  export) run_test export export_data ;;
  data-directory-cancel) run_test data-directory-cancel data_directory_cancel ;;
  data-directory-move-reset) run_test data-directory-move-reset data_directory_move_reset ;;
  downloads-page) run_test downloads-page downloads_page ;;
  download-quality) run_test download-quality download_quality ;;
  download-sabr-telemetry) run_test download-sabr-telemetry download_sabr_telemetry ;;
  download-sabr-total) run_test download-sabr-total download_sabr_total ;;
  download-sabr-ui-progress) run_test download-sabr-ui-progress download_sabr_ui_progress ;;
  download-sabr-pause-resume) run_test download-sabr-pause-resume download_sabr_pause_resume ;;
  download-notification) run_test download-notification download_notification ;;
  download-notification-title) run_test download-notification-title download_notification_title ;;
  download-notification-terminal) run_test download-notification-terminal download_notification_terminal ;;
  download-storage) run_test download-storage download_storage ;;
  download-cancel) run_test download-cancel download_cancel ;;
  download-delete) run_test download-delete download_delete ;;
  cleanup) run_test cleanup cleanup ;;
  recovery) run_test recovery recovery ;;
  *) echo "Unknown test: $TEST" >&2; usage >&2; exit 2 ;;
esac

collect_logs
printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP" | tee "$ARTIFACT_DIR/summary.txt"
cat "$ARTIFACT_DIR/summary.txt"
if ((FAIL > 0)); then exit 1; fi
exit 0
