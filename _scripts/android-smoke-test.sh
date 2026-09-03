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
SCREEN_RECORD_PID=""
RUN_MARKER=$(date +%s%3N)
declare -a TEST_TIMINGS=()

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
                        downloads-page, download-quality, download-sabr-telemetry, download-sabr-total, download-sabr-ui-progress, download-sabr-pause-resume, download-sabr-export, download-notification, download-notification-title, download-notification-terminal, download-storage, download-cancel, download-delete, download-bulk-delete, download-external-delete,
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
start_screen_recording() {
  "$(dirname "$0")/android-screen-record.sh" --serial "$SERIAL" --output "$ARTIFACT_DIR/screen.mp4" >"$ARTIFACT_DIR/screen-record.log" 2>&1 &
  SCREEN_RECORD_PID=$!
  sleep 2
  if ! kill -0 "$SCREEN_RECORD_PID" 2>/dev/null; then
    wait "$SCREEN_RECORD_PID" 2>/dev/null || true
    SCREEN_RECORD_PID=""
    echo "WARN: screen recording did not start; see $ARTIFACT_DIR/screen-record.log" >&2
  fi
}
stop_screen_recording() {
  [[ -n "$SCREEN_RECORD_PID" ]] || return
  kill -TERM "$SCREEN_RECORD_PID" 2>/dev/null || true
  wait "$SCREEN_RECORD_PID" 2>/dev/null || true
  SCREEN_RECORD_PID=""
}
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
trap stop_screen_recording EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
start_screen_recording

ensure_cdp() {
  local pid
  pid=$(adb_shell pidof -s "$PACKAGE")
  [[ -n "$pid" ]] || return 1
  adb_cmd forward --remove tcp:9222 >/dev/null 2>&1 || true
  adb_cmd forward tcp:9222 "localabstract:webview_devtools_remote_$pid" >/dev/null || return 1
  node "$(dirname "$0")/cdp.mjs" 'document.readyState' >/dev/null
}

cdp_eval() {
  node "$(dirname "$0")/cdp.mjs" "$1"
}

cdp_wait() {
  local expression="$1" timeout="${2:-$TIMEOUT}" start now
  start=$(date +%s)
  while :; do
    [[ $(cdp_eval "$expression" 2>/dev/null || true) == true ]] && return 0
    now=$(date +%s)
    ((now - start >= timeout)) && return 1
    sleep 1
  done
}

cdp_wait_status() {
  local id="$1" status="$2" timeout="${3:-$TIMEOUT}" start now
  start=$(date +%s)
  while :; do
    [[ $(cdp_eval "window.__ftTest?.downloads().some(d => d.id === '$id' && d.status === '$status')" 2>/dev/null || true) == true ]] && return 0
    now=$(date +%s)
    ((now - start >= timeout)) && return 1
    sleep 1
  done
}

cdp_wait_inactive() {
  local id="$1" start now
  start=$(date +%s)
  while :; do
    [[ $(cdp_eval "window.__ftTest && !window.__ftTest.active('$id')" 2>/dev/null || true) == true ]] && return 0
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
}

cdp_latest_download_id_since() {
  cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $1).sort((a, b) => b.createdAt - a.createdAt)[0]?.id" | tr -d '"'
}

cdp_click_download_action() {
  local id="$1" action="$2"
  [[ $(cdp_eval "(() => { const row = [...document.querySelectorAll('[data-download-id]')].find(node => node.dataset.downloadId === '$id'); const button = row?.querySelector('[data-download-action=\"$action\"]'); if (!button) return false; button.click(); return true })()") == true ]]
}

cdp_click_bulk_action() {
  local action="$1"
  [[ $(cdp_eval "(() => { const target = document.querySelector('[data-download-action=\"$action\"]'); const button = target?.matches('button') ? target : target?.querySelector('button'); if (!button) return false; button.click(); return true })()") == true ]]
}

cdp_click_prompt_option() {
  local label="$1" result
  for _ in $(seq 1 "$TIMEOUT"); do
    result=$(cdp_eval "(() => { const button = [...document.querySelectorAll('.prompt button')].find(node => node.textContent.trim() === '$label'); if (!button) return false; button.click(); return true })()" 2>/dev/null || true)
    [[ "$result" == true ]] && return 0
    sleep 1
  done
  return 1
}

cdp_start_sabr_download() {
  local marker="$1" expected="$2"
  [[ $(cdp_eval "(() => { const button = document.querySelector('[data-download-action=\"start-download\"] button'); if (!button) return false; button.click(); return true })()") == true ]] || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    if [[ $(cdp_eval "(() => { const buttons = [...document.querySelectorAll('.prompt button')]; const button = buttons.at(-1); if (!button) return false; button.click(); return true })()" 2>/dev/null || true) == true ]]; then break; fi
    sleep 1
  done
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "JSON.parse(localStorage.getItem('freetube-downloads') || '[]').filter(d => d.createdAt >= $marker).length" 2>/dev/null || true) -ge "$expected" ]] && return 0
    sleep 1
  done
  return 1
}

cdp_cleanup_download() {
  local id="$1" status
  status=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.status" | tr -d '"')
  if [[ "$status" =~ ^(queued|downloading|paused)$ ]]; then
    cdp_click_download_action "$id" cancel || return 1
    cdp_wait_status "$id" canceled || return 1
    cdp_wait_inactive "$id" || return 1
  fi
  cdp_click_download_action "$id" delete || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "window.__ftTest.downloads().some(d => d.id === '$id')") == false ]] && return 0
    sleep 1
  done
  return 1
}

open_downloads_cdp() {
  for _ in $(seq 1 "$TIMEOUT"); do
    if ensure_cdp && cdp_eval "location.hash = '#/downloads'; true" >/dev/null && [[ $(cdp_eval 'Boolean(window.__ftTest)' 2>/dev/null || true) == true ]]; then return 0; fi
    sleep 1
  done
  return 1
}

cleanup_run_downloads() {
  device_is_unlocked || return 0
  open_downloads_cdp || return 0
  local ids id
  local -a run_ids
  ids=$(cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $RUN_MARKER).map(d => d.id).join('|')" 2>/dev/null | tr -d '"')
  IFS='|' read -ra run_ids <<<"$ids"
  for id in "${run_ids[@]}"; do
    [[ -n "$id" ]] && cdp_cleanup_download "$id" || true
  done
}

run_test() {
  local name="$1" start elapsed; shift
  echo "== $name =="
  start=$(date +%s)
  if assert_personal_profile && "$@"; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name"
    FAIL=$((FAIL + 1))
  fi
  elapsed=$(($(date +%s) - start))
  TEST_TIMINGS+=("$name=${elapsed}s")
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
  ensure_cdp && cdp_wait "document.readyState === 'complete'"
}

open_search_results() {
  start_app || return 1
  ensure_cdp || return 1
  [[ $(cdp_eval "(() => { const logo = document.querySelector('.logo'); if (!logo) return false; logo.click(); return true })()") == true ]] || return 1
  cdp_wait "Boolean(document.querySelector('.navSearchButton'))" || return 1
  [[ $(cdp_eval "(() => { document.querySelector('.navSearchButton').click(); return true })()") == true ]] || return 1
  cdp_wait "Boolean(document.querySelector('.searchInput input'))" || return 1
  cdp_eval "document.querySelector('.searchInput input').focus(); true" >/dev/null || return 1
  adb_shell input text linux
  adb_shell input keyevent KEYCODE_ENTER
  cdp_wait "location.hash.startsWith('#/search/')"
}

clean_logs() { adb_cmd logcat -c; : >"$LOG_FILE"; }
collect_logs() {
  adb_cmd logcat -d -v brief >"$LOG_FILE"
  adb_shell dumpsys media_session >"$ARTIFACT_DIR/media_session.txt"
  adb_shell dumpsys audio >"$ARTIFACT_DIR/audio.txt"
}
no_runtime_errors() {
  local pid
  collect_logs
  pid=$(adb_shell pidof -s "$PACKAGE" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  adb_cmd logcat -d --pid="$pid" '*:E' >"$ARTIFACT_DIR/runtime-errors.txt"
  ! grep -E 'FATAL EXCEPTION|TypeError:|AndroidRuntime: FATAL' "$ARTIFACT_DIR/runtime-errors.txt" >/dev/null
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
  ensure_cdp && cdp_wait "Boolean(document.querySelector('video'))"
  adb_shell input tap 400 340
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  sleep 3
  screenshot video
}

open_download_video() {
  local attempt
  for attempt in 1 2; do
    adb_cmd logcat -c
    adb_shell am force-stop "$PACKAGE"
    adb_shell am start -a android.intent.action.VIEW -d "$DOWNLOAD_VIDEO_URL" -n "$ACTIVITY" >/dev/null
    wait_for "$PACKAGE" || return 1
    ensure_cdp && cdp_wait "Boolean(document.querySelector('[data-download-action=\"start-download\"] button'))" "$DOWNLOAD_TIMEOUT" || return 1
    if adb_cmd logcat -d --pid="$(adb_shell pidof -s "$PACKAGE")" '*:E' | grep -q 'TypeError:'; then
      [[ "$attempt" == 2 ]] && return 1
      continue
    fi
    adb_shell input tap 400 340
    adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
    sleep 3
    screenshot download-video
    return 0
  done
  return 1
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
  mapping=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  grep -q 'primary%3ADocuments' <<<"$mapping" || return 1
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  open_data_settings || return 1
  adb_shell input tap 500 383
  sleep 8
  mapping=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
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
  playback || return 1
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
  ensure_cdp || return 1
  local marker id format
  marker=$(cdp_eval 'Date.now()')
  cdp_click_bulk_action start-download || return 1
  cdp_click_prompt_option '360p (SABR)' || return 1
  screenshot download-quality
  # WebView text is not exposed reliably to UIAutomator. Check renderer log instead.
  adb_cmd logcat -d -v brief >"$ARTIFACT_DIR/download-quality-logcat.txt"
  grep -q 'picker options' "$ARTIFACT_DIR/download-quality-logcat.txt" || return 1
  grep -Eq '2160p|1440p|1080p|720p|480p|360p|240p|144p' "$ARTIFACT_DIR/download-quality-logcat.txt" || return 1
  wait_for_logcat '"event":"preflight-complete"' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  format=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.selectedFormat" | tr -d '"')
  [[ "$format" =~ ^[0-9]+p\ \(SABR\)$ ]] || return 1
  cdp_wait_status "$id" downloading || cdp_wait_status "$id" completed || return 1
  cdp_cleanup_download "$id"
}

download_sabr_telemetry() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 220 940
  wait_for_logcat 'SABR store complete' || return 1
  adb_cmd logcat -d -v threadtime >"$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt"
  grep -q 'SABR telemetry' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  grep -q '"progress":1' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  grep -Eq 'SABR store complete .*"size":[1-9][0-9]*' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  ! grep -q '"mismatch":true' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed || return 1
  cdp_cleanup_download "$id"
}

download_sabr_total() {
  echo '[download-sabr-total] opening video'
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
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
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed || return 1
  adb_cmd logcat -d -v threadtime >"$ARTIFACT_DIR/download-sabr-total-logcat.txt"
  python3 - "$ARTIFACT_DIR/download-sabr-total-logcat.txt" <<'PY'
import json
import re
import sys

log = open(sys.argv[1], encoding='utf-8').read()
timestamps = [json.loads(value) for value in re.findall(r'SABR timestamp (\{.*?\}) \(webpack', log)]
selection = next((item for item in reversed(timestamps) if item.get('event') == 'selection'), None)
assert selection and selection.get('height') == 1440, selection
preflight = next((item for item in timestamps if item.get('event') == 'preflight-complete' and item.get('id') == selection['id']), None)
assert preflight and preflight.get('total', 0) > 0, preflight
download_id = selection['id']
updates = [json.loads(value) for value in re.findall(r'metadata update (\{.*?\}) \(webpack', log)]
updates = [item for item in updates if item.get('id') == download_id]
progress = [item for item in updates if item.get('status') == 'downloading' and item.get('total', 0) > 0]
assert progress, 'SABR progress totals are missing'
incomplete = [item for item in progress if item.get('received') != item.get('total')]
totals = {item['total'] for item in incomplete}
assert totals == {preflight['total']}, f'total changed during download: preflight={preflight["total"]}, updates={sorted(totals)}'
completed = [item for item in updates if item.get('status') == 'completed']
assert completed, 'SABR completion metadata is missing'
final = completed[-1]
assert final.get('totalExact') is True, f'completed size is not exact: {final}'
assert final.get('received') == final.get('total'), f'exact final bytes mismatch: {final}'
PY
  [[ $? -eq 0 ]] || return 1
  cdp_cleanup_download "$id"
}

download_sabr_ui_progress() {
  echo '[download-sabr-ui-progress] opening video'
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
  echo '[download-sabr-ui-progress] selecting 360p SABR'
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 575 875
  wait_for_logcat '"event":"preflight-complete"' || return 1
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
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed || return 1
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
  [[ $? -eq 0 ]] || return 1
  cdp_cleanup_download "$id"
}

download_sabr_pause_resume() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
  adb_shell input tap 185 830
  sleep 2
  # Select 720p to leave enough time for pause action before completion.
  adb_shell input tap 160 875
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" downloading || return 1
  cdp_click_download_action "$id" pause || return 1
  cdp_wait_status "$id" paused || return 1
  cdp_click_download_action "$id" resume || return 1
  cdp_wait_status "$id" downloading || cdp_wait_status "$id" completed || return 1
  cdp_cleanup_download "$id"
}

download_notification() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
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
  no_runtime_errors || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_cleanup_download "$id"
}

download_notification_title() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
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
  no_runtime_errors || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_cleanup_download "$id"
}

download_notification_terminal() {
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  adb_shell input swipe 360 100 360 1000 500
  sleep 2
  screenshot download-notification-terminal-shade
  ! adb_shell dumpsys notification --noredact | grep -q 'Downloading [0-9]'
}

download_sabr_export() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id uri local_path file_name file_size media_row media_size
  marker=$(cdp_eval 'Date.now()')
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 575 875
  wait_for_logcat '"event":"preflight-complete"' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  uri=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.offlineUri" | tr -d '"')
  local_path=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.localPath" | tr -d '"')
  file_name=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.fileName" | tr -d '"')
  file_size=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.fileSize")
  [[ -n "$uri" && "$uri" != null ]] || return 1
  [[ -n "$local_path" && "$local_path" != null ]] || return 1
  [[ -n "$file_name" && "$file_name" == *.mp4 ]] || return 1
  [[ "$file_size" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == true ]] || return 1
  media_row=$(adb_shell content query --uri "$local_path" --projection _display_name:_size:relative_path:is_pending 2>/dev/null) || return 1
  [[ "$media_row" == *'relative_path=Download/FreeTube/'* && "$media_row" == *'is_pending=0'* ]] || return 1
  [[ "$media_row" =~ _size=[1-9][0-9]* ]] || return 1
  media_size=$(sed -n 's/.*_size=\([0-9][0-9]*\).*/\1/p' <<<"$media_row")
  [[ "$file_size" == "$media_size" ]] || return 1
  [[ "$media_row" != *'.part.mp4'* && "$media_row" != *'.mp4.part'* ]] || return 1
  cdp_cleanup_download "$id"
}

download_storage() { download_sabr_export; }

download_bulk_delete() {
  clean_logs
  local marker ids id1 id2 id file_size uri local_path media_row
  local -a uris=() local_paths=()
  open_download_video || return 1
  ensure_cdp || return 1
  marker=$(cdp_eval 'Date.now()')
  cdp_start_sabr_download "$marker" 1 || return 1
  cdp_start_sabr_download "$marker" 2 || return 1
  open_downloads_cdp || return 1
  ids=$(cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $marker).sort((a, b) => a.createdAt - b.createdAt).map(d => d.id).join('|')" | tr -d '"')
  IFS='|' read -r id1 id2 <<<"$ids"
  [[ -n "$id1" && -n "$id2" && "$id1" != "$id2" ]] || return 1
  for id in "$id1" "$id2"; do
    cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
    file_size=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.fileSize")
    uri=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.offlineUri" | tr -d '"')
    local_path=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.localPath" | tr -d '"')
    [[ "$file_size" =~ ^[1-9][0-9]*$ && -n "$uri" && "$uri" != null && -n "$local_path" && "$local_path" != null ]] || return 1
    [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == true ]] || return 1
    media_row=$(adb_shell content query --uri "$local_path" --projection _size:is_pending 2>/dev/null) || return 1
    [[ "$media_row" == *"_size=$file_size"* && "$media_row" == *'is_pending=0'* ]] || return 1
    uris+=("$uri")
    local_paths+=("$local_path")
  done
  cdp_click_bulk_action select-all || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "['$id1', '$id2'].every(id => document.querySelector('[data-download-id=\"' + id + '\"] input[type=checkbox]')?.checked)") == true ]] && break
    sleep 1
  done
  [[ $(cdp_eval "['$id1', '$id2'].every(id => document.querySelector('[data-download-id=\"' + id + '\"] input[type=checkbox]')?.checked)") == true ]] || return 1
  cdp_click_bulk_action delete-selected || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "['$id1', '$id2'].every(id => !window.__ftTest.downloads().some(d => d.id === id))") == true ]] && break
    sleep 1
  done
  [[ $(cdp_eval "['$id1', '$id2'].every(id => !window.__ftTest.downloads().some(d => d.id === id))") == true ]] || return 1
  for id in 0 1; do
    [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => !items.includes('${uris[$id]}'))") == true ]] || return 1
    ! adb_shell content query --uri "${local_paths[$id]}" --projection _id 2>&1 | grep -q 'Row:' || return 1
  done
}

download_delete() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id uri local_path stale_id
  marker=$(cdp_eval 'Date.now()')
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 575 875
  wait_for_logcat '"event":"preflight-complete"' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  stale_id="smoke-stale-$(date +%s)"
  cdp_eval "(() => { const items = JSON.parse(localStorage.getItem('freetube-downloads') || '[]'); items.push({ downloadId: '$stale_id', title: 'Stale smoke fixture', status: 'completed', offlineUri: 'offline:manifest/idb/v5/999999999', createdAt: Date.now() }); localStorage.setItem('freetube-downloads', JSON.stringify(items)); return true })()" >/dev/null
  sleep 2
  cdp_click_download_action "$stale_id" delete || return 1
  sleep 2
  [[ $(cdp_eval "window.__ftTest.downloads().some(d => d.id === '$stale_id')") == false ]] || return 1
  uri=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.offlineUri" | tr -d '"')
  local_path=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.localPath" | tr -d '"')
  [[ -n "$uri" && "$uri" != null && -n "$local_path" && "$local_path" != null ]] || return 1
  [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == true ]] || return 1
  cdp_click_download_action "$id" delete || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "window.__ftTest.downloads().some(d => d.id === '$id')") == false ]] && break
    sleep 1
  done
  [[ $(cdp_eval "window.__ftTest.downloads().some(d => d.id === '$id')") == false ]] || return 1
  [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == false ]] || return 1
  ! adb_shell content query --uri "$local_path" --projection _id 2>&1 | grep -q 'Row:'
}

download_external_delete() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id uri local_path
  marker=$(cdp_eval 'Date.now()')
  adb_shell input tap 185 830
  sleep 2
  adb_shell input tap 575 875
  wait_for_logcat '"event":"preflight-complete"' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  uri=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.offlineUri" | tr -d '"')
  local_path=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.localPath" | tr -d '"')
  [[ -n "$uri" && "$uri" != null && -n "$local_path" && "$local_path" != null ]] || return 1
  assert_personal_profile || return 1
  adb_shell content delete --user "$PERSONAL_USER_ID" --uri "$local_path" >/dev/null || return 1
  ! adb_shell content query --user "$PERSONAL_USER_ID" --uri "$local_path" --projection _id 2>&1 | grep -q 'Row:' || return 1
  adb_shell input keyevent KEYCODE_HOME
  sleep 1
  adb_shell am start --user "$PERSONAL_USER_ID" -n "$ACTIVITY" >/dev/null
  open_downloads_cdp || return 1
  [[ $(cdp_eval "window.__ftTest.downloads().some(d => d.id === '$id')") == false ]] || return 1
  adb_shell am force-stop --user "$PERSONAL_USER_ID" "$PACKAGE"
  adb_shell am start --user "$PERSONAL_USER_ID" -n "$ACTIVITY" >/dev/null
  open_downloads_cdp || return 1
  [[ $(cdp_eval "window.__ftTest.downloads().some(d => d.id === '$id')") == false ]] || return 1
  cdp_eval "window.__ftTest.removeOffline('$uri')" >/dev/null
  [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == false ]]
}

download_cancel() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id contents_before
  marker=$(cdp_eval 'Date.now()')
  cdp_click_bulk_action start-download || return 1
  cdp_click_prompt_option '1440p (SABR)' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" downloading || return 1
  contents_before=$(cdp_eval 'window.__ftTest.offlineContents()')
  cdp_click_download_action "$id" cancel || return 1
  cdp_wait_status "$id" canceled || return 1
  cdp_wait_inactive "$id" || return 1
  [[ $(cdp_eval 'window.__ftTest.offlineContents()') == "$contents_before" ]] || return 1
  cdp_cleanup_download "$id"
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
  run_test download-sabr-export download_sabr_export
  run_test download-cancel download_cancel
  run_test download-delete download_delete
  run_test download-bulk-delete download_bulk_delete
  run_test download-external-delete download_external_delete
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
  run_test download-sabr-export download_sabr_export
  run_test download-cancel download_cancel
  run_test download-delete download_delete
  run_test download-bulk-delete download_bulk_delete
  run_test download-external-delete download_external_delete
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
    if ! playback; then
      echo "FAIL locked-setup"
      FAIL=$((FAIL + 1))
      return 1
    fi
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
      all)
        run_unlocked_suite || true
        cleanup_run_downloads
        run_locked_suite || true
        ;;
      unlocked)
        run_unlocked_suite || true
        cleanup_run_downloads
        ;;
      locked) run_locked_suite ;;
      downloads)
        run_downloads_suite || true
        cleanup_run_downloads
        ;;
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
  download-sabr-export) run_test download-sabr-export download_sabr_export ;;
  download-storage) run_test download-storage download_storage ;;
  download-cancel) run_test download-cancel download_cancel ;;
  download-delete) run_test download-delete download_delete ;;
  download-bulk-delete) run_test download-bulk-delete download_bulk_delete ;;
  download-external-delete) run_test download-external-delete download_external_delete ;;
  cleanup) run_test cleanup cleanup ;;
  recovery) run_test recovery recovery ;;
  *) echo "Unknown test: $TEST" >&2; usage >&2; exit 2 ;;
esac

collect_logs
stop_screen_recording
{
  printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
  printf 'TIMINGS %s\n' "${TEST_TIMINGS[*]}"
} | tee "$ARTIFACT_DIR/summary.txt"
if ((FAIL > 0)); then exit 1; fi
exit 0
