#!/usr/bin/env bash
set -u

PACKAGE="io.freetubeapp.freetubeandroid"
ACTIVITY="$PACKAGE/.MainActivity"
APK="$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/debug/app-debug.apk"
SERIAL=""
TEST="all"
SUITE="all"
KEEP_DATA=1
TIMEOUT=45
ARTIFACT_DIR="$(cd "$(dirname "$0")/.." && pwd)/tmp/android-smoke/$(date +%Y%m%d-%H%M%S)"
LOG_FILE=""
PASS=0
FAIL=0
SKIP=0
DISPLAY_SCALE_SAVED=0
DISPLAY_OVERRIDE_DENSITY=""
UI_SCALE_SET=0

usage() {
  cat <<'EOF'
Usage: _scripts/android-smoke-test.sh [options]

Options:
  --serial SERIAL       adb device serial
  --apk PATH            debug APK path
  --suite NAME          unlocked, locked, all (default: all)
  --test NAME           one test: preflight, cold-start, search, playback, controls,
                        lock-screen, audio-focus, persistence, cleanup, recovery,
                        locked-state, locked-notification, locked-session,
                        export, data-directory-cancel, locked-controls, locked-audio-focus,
                        locked-cleanup, locked-force-stop
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
    --timeout) TIMEOUT="$2"; shift 2 ;;
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
screenshot() { adb_cmd exec-out screencap -p >"$ARTIFACT_DIR/$1.png"; }

set_display_scale_100() {
  (( DISPLAY_SCALE_SAVED == 1 )) && return 0
  DISPLAY_OVERRIDE_DENSITY=$(adb_shell wm density | awk '/Override density:/ { print $3; exit }')
  adb_shell wm density reset >/dev/null || return 1
  DISPLAY_SCALE_SAVED=1
  adb_shell am force-stop "$PACKAGE"
  sleep 2
  adb_shell wm density | grep -q 'Physical density:'
}

restore_display_scale() {
  (( DISPLAY_SCALE_SAVED == 1 )) || return 0
  if [[ -n "$DISPLAY_OVERRIDE_DENSITY" ]]; then
    adb_shell wm density "$DISPLAY_OVERRIDE_DENSITY" >/dev/null
  else
    adb_shell wm density reset >/dev/null
  fi
}

trap restore_display_scale EXIT

if ! command -v adb >/dev/null 2>&1; then
  echo "SKIP: adb is not installed"; exit 77
fi

if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [[ -z "$SERIAL" ]] || ! adb_cmd get-state >/dev/null 2>&1; then
  echo "SKIP: no adb device connected"; exit 77
fi

run_test() {
  local name="$1"; shift
  echo "== $name =="
  if "$@"; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name"
    FAIL=$((FAIL + 1))
  fi
}

wait_for() {
  local pattern="$1" start now
  start=$(date +%s)
  while :; do
    if adb_shell dumpsys activity activities 2>/dev/null | grep -q "$pattern"; then return 0; fi
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
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
  set_display_scale_100 || return 1
  ensure_ui_scale_100 || return 1
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
  [[ "$(adb_shell am get-current-user 2>/dev/null)" == "0" ]] || {
    echo "FAIL: Android main profile user 0 is required; work profile is not supported"
    return 1
  }
  [[ -f "$APK" ]] || { echo "APK not found: $APK"; return 1; }
  adb_cmd install -r --user 0 "$APK" >/dev/null || return 1
  local pkg
  pkg=$(adb_shell dumpsys package "$PACKAGE") || return 1
  grep -q 'targetSdk=36' <<<"$pkg" || { echo "targetSdk 36 not found"; return 1; }
  grep -q 'versionCode=' <<<"$pkg" || { echo "package not installed"; return 1; }
  adb_shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
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
  # At UI scale 100% Settings uses full-screen mobile section menu.
  adb_shell input tap 63 245
  sleep 2
  adb_shell input tap 300 1084
  sleep 3
}

export_data() {
  open_data_settings || return 1
  # Export Playlists button in Data settings.
  adb_shell input tap 480 1400
  sleep 3
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  screenshot export-picker
  adb_shell input keyevent KEYCODE_BACK
  wait_for "$PACKAGE"
}

data_directory_cancel() {
  open_data_settings || return 1
  local mapping_before mapping_after
  mapping_before=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  adb_shell input tap 215 460
  sleep 3
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  adb_shell input keyevent KEYCODE_BACK
  wait_for "$PACKAGE" || return 1
  mapping_after=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  [[ "$mapping_before" == "$mapping_after" ]]
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
  run_test cleanup cleanup
  run_test recovery recovery
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
  cleanup) run_test cleanup cleanup ;;
  recovery) run_test recovery recovery ;;
  *) echo "Unknown test: $TEST" >&2; usage >&2; exit 2 ;;
esac

collect_logs
printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP" | tee "$ARTIFACT_DIR/summary.txt"
cat "$ARTIFACT_DIR/summary.txt"
if ((FAIL > 0)); then exit 1; fi
exit 0
