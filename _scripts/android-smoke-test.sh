#!/usr/bin/env bash
set -u

PACKAGE="io.freetubeapp.freetubeandroid"
ACTIVITY="$PACKAGE/.MainActivity"
PERSONAL_USER_ID=0
APK="$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/debug/app-debug.apk"
SERIAL=""
TEST="all"
SUITE="all"
DOWNLOAD_VIDEO_URL="https://youtu.be/jNQXAC9IVRw"
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
LOGCAT_STREAM_PID=""
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
                        downloads-page, downloads-selection-ui, download-quality, download-sabr-telemetry, download-sabr-total, download-sabr-quality-totals, download-sabr-quality-pair, download-sabr-quality-repeats, download-sabr-quality-once, download-sabr-1080, download-sabr-ui-progress, download-sabr-pause-resume, download-sabr-export, download-offline-playback, download-selected-directory, download-notification, download-notification-title, download-notification-terminal, download-storage, download-cancel, download-delete, download-bulk-delete, download-restart-queued, download-retry, download-missing-source, download-saf-revoked, online-playlist, user-playlist, android-navigation,
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
RUN_START_SECONDS=$(date +%s)
CURRENT_TEST="setup"
TEST_START_SECONDS=$RUN_START_SECONDS

progress() {
  local now elapsed
  now=$(date +%s)
  elapsed=$((now - TEST_START_SECONDS))
  printf '%s [%s +%ss] %s\n' "$(date +%H:%M:%S)" "$CURRENT_TEST" "$elapsed" "$*" | tee -a "$ARTIFACT_DIR/progress.log"
}

adb_cmd() {
  if [[ -n "$SERIAL" ]]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi
}

adb_shell() { adb_cmd shell "$@"; }
adb_logcat_stream() {
  if [[ -n "$SERIAL" ]]; then
    exec adb -s "$SERIAL" exec-out logcat -v brief
  else
    exec adb exec-out logcat -v brief
  fi
}
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
  stop_logcat_stream
  [[ -n "$SCREEN_RECORD_PID" ]] || return
  kill -TERM "$SCREEN_RECORD_PID" 2>/dev/null || true
  wait "$SCREEN_RECORD_PID" 2>/dev/null || true
  SCREEN_RECORD_PID=""
}
stop_logcat_stream() {
  [[ -n "$LOGCAT_STREAM_PID" ]] || return
  kill "$LOGCAT_STREAM_PID" 2>/dev/null || true
  wait "$LOGCAT_STREAM_PID" 2>/dev/null || true
  LOGCAT_STREAM_PID=""
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
  local text="$1" start now last_log=0
  start=$(date +%s)
  last_log=$start
  progress "waiting for UI text: $text (timeout ${TIMEOUT}s)"
  while :; do
    dump_ui wait-for-ui >/dev/null 2>&1 && grep -q "text=\"$text\"" "$ARTIFACT_DIR/wait-for-ui.xml" && { progress "UI text found: $text"; return 0; }
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for UI text: $text ($((now - start))s/${TIMEOUT}s)"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for UI text: $text ($((now - start))s); artifacts: $ARTIFACT_DIR"
      return 1
    fi
    sleep 1
  done
}

wait_for_logcat() {
  local pattern="$1" start now last_log=0 last_line
  [[ -n "$LOGCAT_STREAM_PID" ]] || { progress "cannot wait for logcat, stream is not running"; return 1; }
  start=$(date +%s)
  last_log=$start
  progress "waiting for logcat: $pattern (timeout ${TIMEOUT}s)"
  while :; do
    if grep -q "$pattern" "$ARTIFACT_DIR/live-logcat.txt" 2>/dev/null; then
      progress "logcat pattern found: $pattern"
      return 0
    fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      last_line=$(tail -1 "$ARTIFACT_DIR/live-logcat.txt" 2>/dev/null || true)
      progress "still waiting for logcat: $pattern ($((now - start))s/${TIMEOUT}s); last=${last_line:-none}"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for logcat: $pattern ($((now - start))s); live log: $ARTIFACT_DIR/live-logcat.txt"
      return 1
    fi
    sleep 1
  done
}

wait_for_notification_actions() {
  local start now dump last_log=0
  start=$(date +%s)
  last_log=$start
  progress "waiting for active download notification (timeout ${TIMEOUT}s)"
  while :; do
    dump=$(adb_shell dumpsys notification --noredact)
    if grep -q 'channel=downloads' <<<"$dump" && grep -q '"Pause"' <<<"$dump" && grep -q '"Cancel"' <<<"$dump" && grep -q 'android.progress=Integer' <<<"$dump"; then
      printf '%s\n' "$dump" >"$ARTIFACT_DIR/download-notification-during.txt"
      progress "active download notification found"
      return 0
    fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for active download notification ($((now - start))s/${TIMEOUT}s)"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for active download notification ($((now - start))s); artifacts: $ARTIFACT_DIR"
      return 1
    fi
    sleep 0.2
  done
}

wait_for_notification() {
  local pattern="$1" start now dump last_log=0
  start=$(date +%s)
  last_log=$start
  progress "waiting for notification: $pattern (timeout ${TIMEOUT}s)"
  while :; do
    dump=$(adb_shell dumpsys notification --noredact)
    if grep -q "$pattern" <<<"$dump"; then
      progress "notification found: $pattern"
      return 0
    fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for notification: $pattern ($((now - start))s/${TIMEOUT}s)"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for notification: $pattern ($((now - start))s); artifacts: $ARTIFACT_DIR"
      return 1
    fi
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

cdp_set_download_metadata() {
  local serialized="$1" encoded
  encoded=$(printf '%s' "$serialized" | base64 -w0)
  [[ $(cdp_eval "(() => { const value = atob('$encoded'); localStorage.setItem('freetube-downloads', value); return window.Android?.replaceDownloadMetadata?.(value) ?? true })()") == true ]]
}

cdp_wait() {
  local expression="$1" timeout="${2:-$TIMEOUT}" start now last_log=0 result_file cdp_pid result
  start=$(date +%s)
  last_log=$start
  result_file="$ARTIFACT_DIR/cdp-wait-$$.result"
  progress "waiting for CDP condition: ${expression:0:120} (timeout ${timeout}s)"
  node "$(dirname "$0")/cdp.mjs" --wait "$expression" "$timeout" >"$result_file" 2>/dev/null &
  cdp_pid=$!
  while kill -0 "$cdp_pid" 2>/dev/null; do
    sleep 1
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for CDP condition ($((now - start))s/${timeout}s): ${expression:0:120}"
      last_log=$now
    fi
  done
  wait "$cdp_pid" 2>/dev/null || true
  result=$(<"$result_file")
  rm -f "$result_file"
  now=$(date +%s)
  if [[ "$result" == true ]]; then
    progress "CDP condition satisfied ($((now - start))s)"
    return 0
  fi
  now=$(date +%s)
  progress "timeout waiting for CDP condition ($((now - start))s/${timeout}s); artifacts: $ARTIFACT_DIR"
  return 1
}

cdp_wait_status() {
  local id="$1" status="$2" timeout="${3:-$TIMEOUT}"
  cdp_wait "window.__ftTest?.downloads().some(d => d.id === '$id' && d.status === '$status')" "$timeout"
}

cdp_wait_inactive() {
  local id="$1"
  cdp_wait "window.__ftTest && !window.__ftTest.active('$id')"
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

cdp_click_sabr_option() {
  local preferred="$1" result
  for _ in $(seq 1 "$TIMEOUT"); do
    result=$(cdp_eval "(() => { const buttons = [...document.querySelectorAll('.prompt button')]; const button = buttons.find(node => node.textContent.trim() === '$preferred') || buttons.find(node => /^[0-9]+p \\(SABR\\)$/.test(node.textContent.trim())); if (!button) return false; button.click(); return true })()" 2>/dev/null || true)
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

cdp_start_sabr_download_quality() {
  local marker="$1" expected="$2" label="$3"
  [[ $(cdp_eval "(() => { const button = document.querySelector('[data-download-action=\"start-download\"] button'); if (!button) return false; button.click(); return true })()") == true ]] || return 1
  cdp_click_prompt_option "$label" || return 1
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
  CURRENT_TEST="$name"
  TEST_START_SECONDS=$(date +%s)
  echo "== $name =="
  progress "started"
  start=$TEST_START_SECONDS
  if assert_personal_profile && "$@"; then
    echo "PASS $name"
    progress "passed"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name"
    progress "failed; artifacts: $ARTIFACT_DIR"
    FAIL=$((FAIL + 1))
  fi
  elapsed=$(($(date +%s) - start))
  TEST_TIMINGS+=("$name=${elapsed}s")
}

is_focused() {
  adb_shell dumpsys activity activities 2>/dev/null | grep -qE "mResumedActivity:.*$1|mFocusedApp=.*$1"
}

wait_for() {
  local pattern="$1" start now last_log=0
  start=$(date +%s)
  last_log=$start
  progress "waiting for focus: $pattern (timeout ${TIMEOUT}s)"
  while :; do
    if is_focused "$pattern"; then progress "focus found: $pattern"; return 0; fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for focus: $pattern ($((now - start))s/${TIMEOUT}s)"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for focus: $pattern ($((now - start))s); artifacts: $ARTIFACT_DIR"
      return 1
    fi
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
  adb_shell am start -n "$ACTIVITY" >/dev/null 2>&1 || return 1
  wait_for "$PACKAGE" || return 1
  ensure_cdp && cdp_wait "Boolean(document.querySelector('.navButton'))" || return 1
  # Open Settings through persistent mobile bottom navigation.
  adb_shell input tap 615 1540
  cdp_wait "location.hash === '#/settings'" || return 1
  # Handle current 70% layout, then normalize after possible reload.
  adb_shell input tap 18 98
  cdp_wait "document.body.innerText.length > 0" || return 1
  adb_shell input tap 55 280
  cdp_wait "document.body.innerText.length > 0" || return 1
  adb_shell input tap 18 98
  cdp_wait "document.body.innerText.length > 0" || return 1
  adb_shell input tap 80 234
  cdp_wait "document.body.innerText.length > 0" || return 1
  adb_shell input tap 385 588
  cdp_wait "document.body.innerText.length > 0" || return 1
  # At 100% Settings uses full-screen mobile section menu.
  adb_shell input tap 63 245
  cdp_wait "document.body.innerText.length > 0" || return 1
  adb_shell input tap 300 444
  cdp_wait "document.body.innerText.length > 0" || return 1
  # Theme UI Scale slider: 50..300%, 100% is x=198 at 100% layout.
  adb_shell input tap 198 934
  cdp_wait "document.body.innerText.length > 0" || return 1
  screenshot ui-scale-100
  UI_SCALE_SET=1
}

start_app() {
  ensure_ui_scale_100 || return 1
  adb_shell am force-stop com.android.documentsui >/dev/null 2>&1 || true
  adb_shell am start -n "$ACTIVITY" >/dev/null 2>&1 || return 1
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

clean_logs() {
  stop_logcat_stream
  adb_cmd logcat -c
  : >"$LOG_FILE"
  : >"$ARTIFACT_DIR/live-logcat.txt"
  adb_logcat_stream >"$ARTIFACT_DIR/live-logcat.txt" 2>/dev/null &
  LOGCAT_STREAM_PID=$!
}
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
  ensure_cdp || return 1
  # Chromium reports normal destruction of short-lived BotGuard renderers as a crash.
  adb_cmd logcat -d --pid="$pid" '*:E' | grep -v 'aw_browser_terminator.cc(165).*code -1' >"$ARTIFACT_DIR/runtime-errors.txt" || true
  ! grep -E 'FATAL EXCEPTION|TypeError:|AndroidRuntime: FATAL' "$ARTIFACT_DIR/runtime-errors.txt" >/dev/null
}

preflight() {
  assert_personal_profile || return 1
  [[ -f "$APK" ]] || { echo "APK not found: $APK"; return 1; }
  adb_cmd install -r --user "$PERSONAL_USER_ID" "$APK" >/dev/null || return 1
  adb_shell am force-stop --user "$PERSONAL_USER_ID" "$PACKAGE"
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
  screenshot video
}

open_download_video() {
  local attempt
  for attempt in 1 2; do
    progress "opening download video (attempt $attempt/2)"
    adb_cmd logcat -c
    adb_shell am force-stop "$PACKAGE"
    adb_shell am start -a android.intent.action.VIEW -d "$DOWNLOAD_VIDEO_URL" -n "$ACTIVITY" >/dev/null
    progress "waiting for app focus after opening video"
    wait_for "$PACKAGE" || return 1
    progress "waiting for download controls (timeout ${DOWNLOAD_TIMEOUT}s)"
    ensure_cdp || return 1
    if ! cdp_wait "Boolean(document.querySelector('[data-download-action=\"start-download\"] button'))" 15; then
      progress 'deep link did not update route; using direct Watch route fallback'
      cdp_eval "location.hash = '#/subscriptions'; setTimeout(() => { location.hash = '#/watch/jNQXAC9IVRw' }, 100); true" >/dev/null || return 1
      cdp_wait "Boolean(document.querySelector('[data-download-action=\"start-download\"] button'))" "$DOWNLOAD_TIMEOUT" || return 1
    fi
    if adb_cmd logcat -d --pid="$(adb_shell pidof -s "$PACKAGE")" '*:E' | grep -q 'TypeError:'; then
      progress "TypeError detected while opening video"
      [[ "$attempt" == 2 ]] && return 1
      continue
    fi
    adb_shell input tap 400 340
    adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
    screenshot download-video
    progress "download video is ready"
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

wait_for_audio_owner() {
  local owner="$1"
  for _ in $(seq 1 "$TIMEOUT"); do
    adb_shell dumpsys audio | grep -q "$owner" && return 0
    sleep 1
  done
  return 1
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
  wait_for "$ref" || return 1
  adb_shell input tap 390 345
  wait_for_audio_owner "$ref" || return 1
  adb_shell am start -n "$ACTIVITY" >/dev/null
  wait_for "$PACKAGE" || return 1
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null
  wait_for_audio_owner "$PACKAGE" || return 1
  no_runtime_errors
}

open_data_settings() {
  start_app || return 1
  # Reopen Settings after cold start or Activity recreation. First close any stale modal.
  adb_shell input tap 615 1540
  ensure_cdp && cdp_wait "location.hash === '#/settings'" || return 1
  adb_shell input keyevent KEYCODE_BACK
  cdp_wait "document.readyState === 'complete'" || return 1
  adb_shell input tap 615 1540
  cdp_wait "location.hash === '#/settings'" || return 1
  # At UI scale 100% Settings uses full-screen mobile section menu.
  adb_shell input tap 300 1084
  cdp_wait "Boolean(document.querySelector('.data-directory'))" || return 1
}

export_data() {
  open_data_settings || return 1
  # Export Playlists button in Data settings.
  adb_shell input tap 480 1070
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  screenshot export-picker
  close_picker
}

data_directory_cancel() {
  open_data_settings || return 1
  local mapping_before mapping_after
  mapping_before=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  adb_shell input tap 215 383
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  close_picker || return 1
  mapping_after=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  [[ "$mapping_before" == "$mapping_after" ]]
}

data_directory_move_reset() {
  open_data_settings || return 1
  adb_shell input tap 215 383
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  # DocumentsUI reopens last tree location; navigate by breadcrumb instead of fixed coordinates.
  adb_shell input tap 72 177
  sleep 2
  adb_shell input tap 475 746
  sleep 2
  adb_shell input tap 360 1560
  sleep 1
  # DocumentsUI asks for explicit access to selected directory.
  adb_shell input tap 610 900
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

downloads_selection_ui() {
  clean_logs
  start_app || return 1
  open_downloads_cdp || return 1
  cdp_eval "window.__ftSmokeDownloadsBackup = window.Android?.getDownloadMetadata?.() || localStorage.getItem('freetube-downloads'); true" >/dev/null || return 1
  cdp_set_download_metadata '[]' || return 1
  cdp_eval "location.hash = '#/subscriptions'; true" >/dev/null || return 1
  sleep 1
  cdp_eval "location.hash = '#/downloads'; true" >/dev/null || return 1
  cdp_wait "document.querySelector('.downloadsView') && document.querySelectorAll('.downloadItem').length === 0" || return 1
  screenshot downloads-selection-empty
  dump_ui downloads-selection-empty || { sleep 1; dump_ui downloads-selection-empty || return 1; }
  [[ $(cdp_eval 'Boolean(document.querySelector("[data-download-action=select-all]"))') == false ]] || return 1
  cdp_set_download_metadata "[{\"downloadId\":\"smoke-selection-1\",\"videoId\":\"smoke-selection-1\",\"title\":\"Selection UI smoke fixture 1\",\"status\":\"completed\",\"selectedFormat\":\"360p\",\"createdAt\":$(date +%s%3N)}]" || return 1
  cdp_eval "location.hash = '#/subscriptions'; true" >/dev/null || return 1
  sleep 1
  cdp_eval "location.hash = '#/downloads'; true" >/dev/null || return 1
  cdp_wait "document.querySelectorAll('.downloadItem').length === 1 && Boolean(document.querySelector('[data-download-action=select-all]'))" || return 1
  [[ $(cdp_eval 'document.querySelector("[data-download-action=select-all]")?.disabled') == false ]] || return 1
  cdp_click_bulk_action select-all || return 1
  cdp_wait "document.querySelectorAll('.downloadSelect:checked').length === 1" || return 1
  cdp_click_bulk_action select-all || return 1
  cdp_wait "document.querySelectorAll('.downloadSelect:checked').length === 0" || return 1
  cdp_set_download_metadata "[$(for i in $(seq 0 7); do printf '%s' "{\"downloadId\":\"smoke-selection-$i\",\"videoId\":\"smoke-selection-$i\",\"title\":\"Selection UI smoke fixture $i\",\"status\":\"completed\",\"selectedFormat\":\"360p\",\"createdAt\":$(($(date +%s%3N)+i))}"; [[ $i -lt 7 ]] && printf ','; done)]" || return 1
  cdp_eval "location.hash = '#/subscriptions'; true" >/dev/null || return 1
  sleep 1
  cdp_eval "location.hash = '#/downloads'; true" >/dev/null || return 1
  cdp_wait "document.querySelectorAll('.downloadItem').length === 8" || return 1
  cdp_wait "[...document.querySelectorAll('.downloadThumbnail')].every(image => image.naturalWidth > 0)" || return 1
  [[ $(cdp_eval "(() => { const view = document.querySelector('.downloadsView'); const nav = document.querySelector('.sideNav'); view.scrollTop = view.scrollHeight; const last = document.querySelector('.downloadItem:last-of-type').getBoundingClientRect(); return last.bottom <= nav.getBoundingClientRect().top })()") == true ]] || return 1
  cdp_eval "document.querySelector('.downloadsView').scrollTop = 0; true" >/dev/null || return 1
  sleep 1
  dump_ui downloads-selection-before-select || return 1
  tap_ui_text 'Select all' || return 1
  cdp_wait "document.querySelector('[data-download-action=\"select-all\"]')?.textContent.trim() === 'Clear selection' && document.querySelectorAll('.downloadSelect:checked').length === 8" || return 1
  dump_ui downloads-selection-before-clear || return 1
  cdp_eval "document.querySelector('[data-download-action=\"select-all\"]')?.click(); true" >/dev/null || return 1
  cdp_wait "document.querySelector('[data-download-action=\"select-all\"]')?.textContent.trim() === 'Select all' && document.querySelectorAll('.downloadSelect:checked').length === 0" || return 1
  [[ $(cdp_eval 'getComputedStyle(document.querySelector("[data-download-action=select-all]")).backgroundColor') != 'rgb(229, 57, 53)' ]] || return 1
  cdp_eval "(() => { const value = window.__ftSmokeDownloadsBackup || '[]'; localStorage.setItem('freetube-downloads', value); return window.Android?.replaceDownloadMetadata?.(value) ?? true })()" >/dev/null || return 1
  cdp_eval "location.hash = '#/subscriptions'; true" >/dev/null || return 1
  sleep 1
  cdp_eval "location.hash = '#/downloads'; delete window.__ftSmokeDownloadsBackup; true" >/dev/null || return 1
}

download_quality() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id format
  marker=$(cdp_eval 'Date.now()')
  cdp_click_bulk_action start-download || return 1
  cdp_click_prompt_option '240p (SABR)' || return 1
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
  progress "starting SABR telemetry scenario"
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
  progress "opening quality picker"
  adb_shell input tap 185 830
  sleep 2
  progress "selecting telemetry download quality"
  cdp_click_sabr_option '360p (SABR)' || return 1
  progress "download started; waiting for SABR store completion"
  wait_for_logcat 'SABR store complete' || return 1
  progress "SABR store completed; collecting telemetry log"
  adb_cmd logcat -d -v threadtime >"$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt"
  grep -q 'SABR telemetry' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  grep -q '"progress":1' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  grep -Eq 'SABR store complete .*"size":[1-9][0-9]*' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  ! grep -q '"mismatch":true' "$ARTIFACT_DIR/download-sabr-telemetry-logcat.txt" || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  progress "checking completed download state"
  cdp_wait_status "$id" completed || return 1
  progress "cleaning up telemetry download"
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
  cdp_click_prompt_option '1440p (SABR)' || return 1
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
totals = {item['total'] for item in progress}
assert totals == {preflight['total']}, f'total changed during download: preflight={preflight["total"]}, updates={sorted(totals)}'
completed = [item for item in updates if item.get('status') == 'completed']
assert completed, 'SABR completion metadata is missing'
final = completed[-1]
assert final.get('phase') == 'completed', f'offline-only phase is not completed: {final}'
assert final.get('totalExact') is True, f'completed size is not exact: {final}'
assert final.get('received') == final.get('total'), f'exact final bytes mismatch: {final}'
assert not any(item.get('phase') in {'exporting', 'export-failed'} for item in updates), updates
PY
  [[ $? -eq 0 ]] || return 1
  cdp_cleanup_download "$id"
}

download_sabr_1080() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
  cdp_eval "localStorage.removeItem('freetube-download-concurrency'); true" >/dev/null
  cdp_start_sabr_download_quality "$marker" 1 '1080p (SABR)' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  adb_cmd logcat -d -v threadtime >"$ARTIFACT_DIR/download-sabr-1080-logcat.txt"
  python3 - "$ARTIFACT_DIR/download-sabr-1080-logcat.txt" "$ARTIFACT_DIR/download-sabr-1080-latency.txt" "$id" <<'PY'
import json
import re
import sys

log = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
download_id = sys.argv[3]
events = {}
for value in re.findall(r'SABR timestamp (\{"id".*?\})', log):
    item = json.loads(value)
    if item.get('id') == download_id:
        events[item['event']] = item['timestamp']
for event in ('quality-click', 'preflight-complete', 'slot-acquired', 'store-started', 'first-progress', 'completed'):
    assert event in events, f'missing {event}: {events}'
with open(sys.argv[2], 'w', encoding='utf-8') as output:
    for start, end in [('quality-click', 'preflight-complete'), ('preflight-complete', 'slot-acquired'), ('slot-acquired', 'store-started'), ('store-started', 'first-progress'), ('quality-click', 'first-progress')]:
        output.write(f'{start}_to_{end}_ms={events[end] - events[start]}\n')
PY
  [[ $? -eq 0 ]] || return 1
  cdp_cleanup_download "$id"
}

download_sabr_quality_pair() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker ids id
  marker=$(cdp_eval 'Date.now()')
  cdp_eval "localStorage.removeItem('freetube-download-concurrency'); true" >/dev/null
  cdp_start_sabr_download_quality "$marker" 1 '1440p (SABR)' || return 1
  cdp_start_sabr_download_quality "$marker" 2 '1080p (SABR)' || return 1
  open_downloads_cdp || return 1
  ids=$(cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $marker).map(d => d.id).join('|')" | tr -d '"')
  IFS='|' read -ra download_ids <<<"$ids"
  [[ ${#download_ids[@]} -eq 2 ]] || return 1
  for id in "${download_ids[@]}"; do
    cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  done
  for id in "${download_ids[@]}"; do cdp_cleanup_download "$id" || return 1; done
}

download_sabr_quality_totals() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker ids
  marker=$(cdp_eval 'Date.now()')
  # Use default concurrency: 1440p consumes two of five available slots.
  cdp_eval "localStorage.removeItem('freetube-download-concurrency'); true" >/dev/null
  cdp_start_sabr_download_quality "$marker" 1 '1440p (SABR)' || return 1
  cdp_start_sabr_download_quality "$marker" 2 '480p (SABR)' || return 1
  cdp_start_sabr_download_quality "$marker" 3 '360p (SABR)' || return 1
  open_downloads_cdp || return 1
  cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $marker)" >"$ARTIFACT_DIR/download-sabr-quality-totals-start.json"
  screenshot download-sabr-quality-totals-start
  dump_ui download-sabr-quality-totals-start || return 1
  ids=$(cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $marker).map(d => d.id).join('|')" | tr -d '"')
  python3 - "$ARTIFACT_DIR/download-sabr-quality-totals-start.json" <<'PY'
import json
import sys

items = json.load(open(sys.argv[1], encoding='utf-8'))
assert [item['selectedFormat'] for item in items] == ['1440p (SABR)', '480p (SABR)', '360p (SABR)'], items
assert len({item['total'] for item in items}) == 3 and all(item['total'] > 0 for item in items), items
PY
  [[ $? -eq 0 ]] || return 1
  IFS='|' read -ra download_ids <<<"$ids"
  for _ in $(seq 1 "$DOWNLOAD_TIMEOUT"); do
    [[ $(grep -Ec 'SABR timestamp .*"event":"(store-started|first-progress)"' "$ARTIFACT_DIR/live-logcat.txt" || true) -ge 6 ]] && break
    sleep 1
  done
  python3 - "$ARTIFACT_DIR/download-sabr-quality-totals-start.json" "$ARTIFACT_DIR/download-sabr-quality-totals-start-times.txt" "$ARTIFACT_DIR/live-logcat.txt" <<'PY'
import json
import re
import sys

items = json.load(open(sys.argv[1], encoding='utf-8'))
log = open(sys.argv[3], encoding='utf-8', errors='ignore').read()
events = {}
for value in re.findall(r'SABR timestamp (\{"id".*?\})', log):
    item = json.loads(value)
    if item.get('id') in {entry['id'] for entry in items} and item.get('event') in {'store-started', 'first-progress'}:
        events.setdefault(item['event'], {})[item['id']] = item['timestamp']
for event in ('store-started', 'first-progress'):
    assert len(events.get(event, {})) == 3, f'missing {event} timestamps: {events.get(event, {})}'
first_progress_spread = max(events['first-progress'].values()) - min(events['first-progress'].values())
assert first_progress_spread <= 5000, f'first-byte start spread is {first_progress_spread}ms'
with open(sys.argv[2], 'w', encoding='utf-8') as output:
    output.write(f'store_started_spread_ms={max(events["store-started"].values()) - min(events["store-started"].values())}\n')
    output.write(f'first_progress_spread_ms={first_progress_spread}\n')
    for item in items:
        output.write(f"{item['selectedFormat']}_first_progress_ms={events['first-progress'][item['id']]}\n")
PY
  [[ $? -eq 0 ]] || return 1
  local id
  for id in "${download_ids[@]}"; do cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1; done
  cdp_eval "window.__ftTest.downloads().filter(d => d.createdAt >= $marker)" >"$ARTIFACT_DIR/download-sabr-quality-totals-complete.json"
  python3 - "$ARTIFACT_DIR/download-sabr-quality-totals-complete.json" <<'PY'
import json
import sys

items = json.load(open(sys.argv[1], encoding='utf-8'))
assert len(items) == 3, items
assert all(item['received'] == item['total'] and item['totalExact'] is True for item in items), items
PY
  [[ $? -eq 0 ]] || return 1
  for id in "${download_ids[@]}"; do cdp_cleanup_download "$id" || return 1; done
  cdp_eval "localStorage.removeItem('freetube-download-concurrency'); true" >/dev/null
}

download_sabr_quality_repeats() {
  local quality repeat marker id sample_file
  local qualities=('1440p (SABR)' '1080p (SABR)' '720p (SABR)' '480p (SABR)' '360p (SABR)')
  local repeats=3
  local sample_name=download-sabr-quality-repeats
  if [[ "$TEST" == download-sabr-quality-once ]]; then
    qualities=('480p (SABR)' '360p (SABR)')
    repeats=1
    sample_name=download-sabr-quality-once
  fi
  sample_file="$ARTIFACT_DIR/$sample_name.jsonl"
  : >"$sample_file"
  for quality in "${qualities[@]}"; do
    for repeat in $(seq 1 "$repeats"); do
      CURRENT_TEST="$sample_name-$quality-$repeat"
      progress "starting $quality repeat $repeat/$repeats"
      clean_logs
      open_download_video || return 1
      ensure_cdp || return 1
      marker=$(cdp_eval 'Date.now()')
      cdp_start_sabr_download_quality "$marker" 1 "$quality" || return 1
      open_downloads_cdp || return 1
      id=$(cdp_latest_download_id_since "$marker")
      [[ -n "$id" && "$id" != null ]] || return 1
      screenshot "$sample_name-${quality%% *}-$repeat"
      for second in $(seq 0 0.1 "$DOWNLOAD_TIMEOUT"); do
        cdp_eval "(() => { const d = window.__ftTest.downloads().find(item => item.id === '$id'); const bar = document.querySelector('[data-download-id=\\\"$id\\\"] progress'); return {quality:'$quality',repeat:$repeat,second:$second,id:'$id',hash:location.hash,status:d?.status,progress:d?.progress ?? null,received:d?.received ?? 0,total:d?.total ?? 0,totalExact:d?.totalExact ?? false,barVisible:Boolean(bar),barValue:bar ? bar.value : null,barMax:bar ? bar.max : null,barComplete:Boolean(bar && bar.value >= bar.max)} })()" >>"$sample_file" || return 1
        screenshot "$sample_name-${quality%% *}-$repeat-${second}s"
        status=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.status" | tr -d '"')
        [[ "$status" == completed ]] && break
        sleep 0.1
      done
      cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
      cdp_eval "(() => { const d = window.__ftTest.downloads().find(item => item.id === '$id'); const bar = document.querySelector('[data-download-id=\\\"$id\\\"] progress'); return {...d,quality:'$quality',repeat:$repeat,hash:location.hash,barVisible:Boolean(bar),barValue:bar ? bar.value : null,barMax:bar ? bar.max : null,barComplete:Boolean(bar && bar.value >= bar.max),terminal:true} })()" >>"$sample_file" || return 1
      cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')" >"$ARTIFACT_DIR/$sample_name-$repeat-${quality%% *}-complete.json" || return 1
      cdp_cleanup_download "$id" || return 1
    done
  done
  python3 - "$sample_file" "${#qualities[@]}" "$repeats" <<'PY'
import json
import sys

samples = [json.loads(line) for line in open(sys.argv[1], encoding='utf-8') if line.strip()]
expected = int(sys.argv[2]) * int(sys.argv[3])
assert len({(item['quality'], item['repeat']) for item in samples}) == expected, samples
for item in samples:
    assert not item['barComplete'] or item['status'] == 'completed', item
completed = [item for item in samples if item.get('terminal') and item['status'] == 'completed']
assert len(completed) == expected, completed
assert all(item['received'] == item['total'] and item['totalExact'] is True and item['progress'] == 1 and not item['barVisible'] for item in completed), completed
PY
}

download_sabr_ui_progress() {
  echo '[download-sabr-ui-progress] opening video'
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id
  marker=$(cdp_eval 'Date.now()')
  echo '[download-sabr-ui-progress] selecting 1440p SABR'
  adb_shell input tap 185 830
  sleep 2
  local tap_sent_ms tap_done_ms
  tap_sent_ms=$(date +%s%3N)
  progress "quality option tap sent at ${tap_sent_ms}ms"
  cdp_click_prompt_option '1440p (SABR)' || return 1
  tap_done_ms=$(date +%s%3N)
  progress "quality option tap completed at ${tap_done_ms}ms"
  printf 'quality_option_tap_sent_ms=%s\nquality_option_tap_completed_ms=%s\n' "$tap_sent_ms" "$tap_done_ms" >"$ARTIFACT_DIR/download-latency.txt"
  wait_for_logcat '"event":"preflight-complete"' || return 1
  adb_shell input tap 535 1540
  cdp_wait "JSON.parse(localStorage.getItem('freetube-downloads') || '[]').some(d => d.createdAt >= $marker)" "$TIMEOUT" || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  open_downloads_cdp || return 1
  cdp_wait "Boolean(document.querySelector('[data-download-id=\"$id\"] .downloadMeta'))" "$DOWNLOAD_TIMEOUT" || return 1
  echo '[download-sabr-ui-progress] download started on Downloads page, waiting for completion'
  screenshot download-sabr-ui-progress
  dump_ui download-sabr-ui-progress || true
  test -s "$ARTIFACT_DIR/download-sabr-ui-progress.png" || return 1
  local metrics_line metrics_layout
  [[ $(cdp_eval "location.hash === '#/downloads' && Boolean(document.querySelector('.downloadsView'))") == true ]] || return 1
  metrics_line=$(cdp_eval "document.querySelector('[data-download-id=\"$id\"] .downloadMeta')?.textContent || ''" | tr -d '"')
  echo "[download-sabr-ui-progress] metrics_line=$metrics_line"
  [[ "$metrics_line" == *'MB/s'* ]] || return 1
  metrics_layout=$(cdp_eval "(() => { const node = document.querySelector('[data-download-id=\"$id\"] .downloadMeta'); if (!node) return false; const style = getComputedStyle(node); return node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().height <= parseFloat(style.fontSize) * 1.8 })()")
  echo "[download-sabr-ui-progress] metrics_layout=$metrics_layout"
  [[ "$metrics_layout" == true ]] || return 1
  if grep -q 'downloading' "$ARTIFACT_DIR/download-sabr-ui-progress.xml"; then
    grep -Eq '[0-9]+% · [1-9][0-9.]*(/[1-9][0-9.]*)? (KB|MB|GB).*MB/s' "$ARTIFACT_DIR/download-sabr-ui-progress.xml" || return 1
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
  grep -q 'metadata update.*"status":"completed".*"phase":"completed"' "$ARTIFACT_DIR/download-sabr-ui-progress-logcat.txt" || return 1
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
  # Pause through notification-control path as soon as metadata enters downloading state.
  cdp_eval "window.__ftSmokePauseTimer = setInterval(() => { const item = JSON.parse(localStorage.getItem('freetube-downloads') || '[]').find(d => d.createdAt >= $marker && d.status === 'downloading'); if (!item) return; clearInterval(window.__ftSmokePauseTimer); window.dispatchEvent(new CustomEvent('android-download-control', { detail: { id: item.downloadId, action: 'pause' } })); }, 10); true" >/dev/null || return 1
  cdp_click_sabr_option '720p (SABR)' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" paused || return 1
  cdp_wait_status "$id" paused || return 1
  [[ $(cdp_eval "window.__ftTest?.control?.('$id', 'resume')") == true ]] || return 1
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
  # Prefer 720p, but use fixture-provided SABR quality when it is unavailable.
  cdp_click_sabr_option '720p (SABR)' || return 1
  wait_for_notification_actions || return 1
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
  cdp_click_prompt_option '720p (SABR)' || return 1
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
  local marker id uri received total progress video_id
  marker=$(cdp_eval 'Date.now()')
  adb_shell input tap 185 830
  sleep 2
  cdp_click_prompt_option '240p (SABR)' || return 1
  wait_for_logcat '"event":"preflight-complete"' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  uri=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.offlineUri" | tr -d '"')
  received=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.received")
  total=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.total")
  progress=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.progress")
  [[ -n "$uri" && "$uri" != null ]] || return 1
  [[ "$received" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$total" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$progress" == 1 ]] || return 1
  [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == true ]] || return 1
  if [[ "${1:-}" == playback ]]; then
    video_id=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.videoId" | tr -d '"')
    cdp_eval "location.hash = '#/watch/$video_id?offline=$id'; true" >/dev/null || return 1
    cdp_wait 'location.hash.includes("/watch/") && Boolean(document.querySelector(`[data-offline-playback="true"]`))' "$((DOWNLOAD_TIMEOUT + 120))" || return 1
    cdp_wait 'Boolean(document.querySelector(".videoPlayer"))' "$((DOWNLOAD_TIMEOUT + 120))" || return 1
    [[ $(cdp_eval 'Boolean(document.querySelector(`[data-offline-playback="true"]`)) && !document.body.innerText.includes("Downloaded file is unavailable")') == true ]] || return 1
  fi
  open_downloads_cdp || return 1
  cdp_cleanup_download "$id"
}

download_storage() { download_sabr_export; }
download_offline_playback() { download_sabr_export playback; }

download_bulk_delete() {
  clean_logs
  local marker ids id1 id2 id uri
  local -a uris=()
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
    uri=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.offlineUri" | tr -d '"')
    [[ -n "$uri" && "$uri" != null ]] || return 1
    [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => items.includes('$uri'))") == true ]] || return 1
    uris+=("$uri")
  done
  cdp_click_bulk_action select-all || return 1
  cdp_click_bulk_action select-all || return 1
  cdp_eval "['$id1', '$id2'].forEach(id => [...document.querySelectorAll('[data-download-id]')].find(node => node.dataset.downloadId === id)?.querySelector('input[type=checkbox]')?.click()); true" >/dev/null || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "['$id1', '$id2'].every(id => document.querySelector('[data-download-id=\"' + id + '\"] input[type=checkbox]')?.checked)") == true ]] && break
    sleep 1
  done
  [[ $(cdp_eval "['$id1', '$id2'].every(id => document.querySelector('[data-download-id=\"' + id + '\"] input[type=checkbox]')?.checked)") == true ]] || return 1
  cdp_click_bulk_action play-selected || return 1
  cdp_wait 'location.hash.includes("offlinePlaylist=") && Boolean(document.querySelector(`[data-offline-playback="true"]`))' "$DOWNLOAD_TIMEOUT" || return 1
  cdp_wait 'Boolean(document.querySelector(".videoPlayer"))' "$DOWNLOAD_TIMEOUT" || return 1
  cdp_eval "window.dispatchEvent(new Event('media-next')); true" >/dev/null || return 1
  cdp_wait "location.hash.includes('offline=$id2')" "$DOWNLOAD_TIMEOUT" || return 1
  cdp_eval "window.dispatchEvent(new Event('media-previous')); true" >/dev/null || return 1
  cdp_wait "location.hash.includes('offline=$id1')" "$DOWNLOAD_TIMEOUT" || return 1
  cdp_eval 'history.back(); true' >/dev/null || return 1
  open_downloads_cdp || return 1
  cdp_click_download_action "$id1" delete || return 1
  cdp_click_download_action "$id2" delete || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    [[ $(cdp_eval "['$id1', '$id2'].every(id => !window.__ftTest.downloads().some(d => d.id === id))") == true ]] && break
    sleep 1
  done
  [[ $(cdp_eval "['$id1', '$id2'].every(id => !window.__ftTest.downloads().some(d => d.id === id))") == true ]] || return 1
  for id in 0 1; do
    [[ $(cdp_eval "window.__ftTest.offlineContents().then(items => !items.includes('${uris[$id]}'))") == true ]] || return 1
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
  cdp_click_sabr_option '240p (SABR)' || return 1
  wait_for_logcat '"event":"preflight-complete"' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" completed "$DOWNLOAD_TIMEOUT" || return 1
  stale_id="smoke-stale-$(date +%s)"
  cdp_eval "(() => { const items = JSON.parse(window.Android?.getDownloadMetadata?.() || localStorage.getItem('freetube-downloads') || '[]'); items.push({ downloadId: '$stale_id', title: 'Stale smoke fixture', status: 'completed', offlineUri: 'offline:manifest/idb/v5/999999999', createdAt: Date.now() }); const value = JSON.stringify(items); localStorage.setItem('freetube-downloads', value); return window.Android?.replaceDownloadMetadata?.(value) ?? true })()" >/dev/null || return 1
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

download_retry() {
  clean_logs
  start_app || return 1
  ensure_cdp || return 1
  local id status
  id="smoke-retry-$(date +%s%3N)"
  cdp_set_download_metadata "[{\"downloadId\":\"$id\",\"videoId\":\"$id\",\"title\":\"Retry smoke fixture\",\"status\":\"queued\",\"engine\":\"native\",\"selectedFormat\":\"native\",\"createdAt\":$(date +%s%3N)}]" || return 1
  cdp_eval "window.Android.enqueueNativeDownload(JSON.stringify({id:'$id',downloadId:'$id',videoId:'$id',title:'Retry smoke fixture',selectedFormat:'native',engine:'native',videoUrl:'https://invalid.invalid/smoke-retry.mp4',audioUrl:'',targetUri:'data://smoke-retry.mp4',sourceLocator:'data://smoke-retry.mp4',finalName:'smoke-retry.mp4'}))" | grep -q true || return 1
  for _ in $(seq 1 "$DOWNLOAD_TIMEOUT"); do
    status=$(cdp_eval "JSON.parse(window.Android.getNativeDownloadQueue()).find(item => item.id === '$id')?.status" | tr -d '"')
    [[ "$status" == failed ]] && break
    sleep 1
  done
  [[ "$status" == failed ]] || return 1
  open_downloads_cdp || return 1
  cdp_click_download_action "$id" retry || return 1
  for _ in $(seq 1 "$TIMEOUT"); do
    status=$(cdp_eval "JSON.parse(window.Android.getNativeDownloadQueue()).find(item => item.id === '$id')?.status" | tr -d '"')
    [[ "$status" == queued || "$status" == downloading ]] && break
    sleep 1
  done
  [[ "$status" == queued || "$status" == downloading ]] || return 1
  for _ in $(seq 1 "$DOWNLOAD_TIMEOUT"); do
    status=$(cdp_eval "JSON.parse(window.Android.getNativeDownloadQueue()).find(item => item.id === '$id')?.status" | tr -d '"')
    [[ "$status" == failed ]] && break
    sleep 1
  done
  [[ "$status" == failed ]]
}

download_restart_queued() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id status
  marker=$(cdp_eval 'Date.now()')
  cdp_start_sabr_download "$marker" 1 || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  adb_shell am force-stop "$PACKAGE"
  sleep 3
  start_app || return 1
  open_downloads_cdp || return 1
  for _ in $(seq 1 "$DOWNLOAD_TIMEOUT"); do
    status=$(cdp_eval "window.__ftTest.downloads().find(d => d.id === '$id')?.status" | tr -d '"')
    [[ "$status" == completed ]] && break
    sleep 1
  done
  [[ "$status" == completed ]] || return 1
  cdp_cleanup_download "$id"
}

online_playlist() {
  clean_logs
  start_app || return 1
  adb_shell am start -a android.intent.action.VIEW -d 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl-2TQvOiD5Vgm1hCaGSI' -n "$ACTIVITY" >/dev/null
  ensure_cdp || return 1
  if ! cdp_wait "location.hash.startsWith('#/playlist/')" 15; then
    cdp_eval "location.hash = '#/playlist/PLFgquLnL59alCl-2TQvOiD5Vgm1hCaGSI'; true" >/dev/null || return 1
  fi
  cdp_wait 'Boolean(document.querySelector(".playlistPage"))' "$DOWNLOAD_TIMEOUT" || return 1
  no_runtime_errors
}

android_navigation() {
  clean_logs
  start_app || return 1
  cdp_eval "location.hash = '#/settings'; true" >/dev/null || return 1
  cdp_wait "location.hash === '#/settings'" || return 1
  cdp_eval "location.hash = '#/downloads'; true" >/dev/null || return 1
  cdp_wait "location.hash === '#/downloads'" || return 1
  adb_shell input keyevent KEYCODE_BACK
  cdp_wait "location.hash === '#/settings'" || return 1
  no_runtime_errors
}

user_playlist() {
  clean_logs
  start_app || return 1
  cdp_eval "location.hash = '#/playlist/favorites'; true" >/dev/null || return 1
  cdp_wait 'Boolean(document.querySelector(".playlistPage"))' "$DOWNLOAD_TIMEOUT" || return 1
  no_runtime_errors
}

download_missing_source() {
  clean_logs
  start_app || return 1
  ensure_cdp || return 1
  cdp_eval "window.__ftSmokeDownloadsBackup = window.Android?.getDownloadMetadata?.() || localStorage.getItem('freetube-downloads'); true" >/dev/null || return 1
  cdp_set_download_metadata "[{\"downloadId\":\"smoke-corrupt-source\",\"videoId\":\"smoke-corrupt-source\",\"title\":\"Corrupt source smoke fixture\",\"status\":\"completed\",\"offlineUri\":null,\"localVideoPath\":null,\"createdAt\":$(date +%s%3N)}]" || return 1
  cdp_eval "location.hash = '#/watch/smoke-corrupt-source?offline=smoke-corrupt-source'; true" >/dev/null || return 1
  cdp_wait 'Boolean(document.querySelector(`[data-offline-playback="true"]`))' || return 1
  cdp_wait 'document.body.innerText.includes("Downloaded file is unavailable")' || return 1
  cdp_eval "(() => { const value = window.__ftSmokeDownloadsBackup || '[]'; localStorage.setItem('freetube-downloads', value); return window.Android?.replaceDownloadMetadata?.(value) ?? true })()" >/dev/null || return 1
}

download_saf_revoked() {
  download_selected_directory || return 1
  local directory
  ensure_cdp || return 1
  directory=$(cdp_eval 'localStorage.getItem("freetube-download-directory")' | tr -d '"')
  progress "selected SAF directory: $directory"
  [[ "$directory" == content://* ]] || return 1
  cdp_eval "window.Android.revokePermissionForTree('$directory'); true" >/dev/null || return 1
  local accessible created
  accessible=$(cdp_eval "window.Android.isTreeAccessible('$directory')")
  progress "SAF access after revoke: $accessible"
  [[ "$accessible" == false ]] || return 1
  created=$(cdp_eval "window.Android.createDownloadFile('$directory', 'revoked-smoke.mp4')" | tr -d '"')
  progress "revoked target creation result: $created"
  [[ -z "$created" ]] || return 1
  cdp_eval 'localStorage.removeItem("freetube-download-directory"); true' >/dev/null
}

download_selected_directory() {
  clean_logs
  start_app || return 1
  ensure_cdp || return 1
  cdp_eval "location.hash = '#/settings'; true" >/dev/null || return 1
  cdp_wait 'Boolean(document.querySelector(".settingsPage"))' || return 1
  cdp_wait 'Boolean(document.querySelector(`.settingsMenu [data-section="downloads"]`))' || return 1
  cdp_eval "document.querySelector('.settingsMenu [data-section=\"downloads\"]')?.click(); true" >/dev/null || return 1
  cdp_wait 'Boolean(document.querySelector("[data-download-settings-action=choose-folder]"))' || return 1
  cdp_eval 'document.querySelector("[data-download-settings-action=choose-folder]").click(); true' >/dev/null || return 1
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  dump_ui directory-picker || return 1
  tap_ui_text 'moto g34 5G' || return 1
  sleep 2
  dump_ui directory-picker-root || return 1
  tap_ui_text 'Download' || return 1
  sleep 2
  dump_ui directory-picker-download || return 1
  tap_ui_text 'FreeTube' || return 1
  sleep 2
  dump_ui directory-picker-freetube || return 1
  adb_shell input tap 360 1560
  wait_for_ui_text ALLOW || return 1
  adb_shell input tap 610 900
  sleep 8
  ensure_cdp || return 1
  [[ $(cdp_eval 'localStorage.getItem("freetube-download-directory") || ""' | tr -d '"') == content://* ]] || return 1
}

download_cancel() {
  clean_logs
  open_download_video || return 1
  ensure_cdp || return 1
  local marker id contents_before contents_after
  open_downloads_cdp || return 1
  contents_before=$(cdp_eval 'window.__ftTest.offlineContents()')
  adb_shell am start -a android.intent.action.VIEW -d "$DOWNLOAD_VIDEO_URL" -n "$ACTIVITY" >/dev/null
  wait_for "$PACKAGE" || return 1
  ensure_cdp && cdp_wait "Boolean(document.querySelector('[data-download-action=\"start-download\"] button'))" "$DOWNLOAD_TIMEOUT" || return 1
  marker=$(cdp_eval 'Date.now()')
  cdp_click_bulk_action start-download || return 1
  cdp_eval "window.__ftSmokeCancelTimer = setInterval(() => { const item = JSON.parse(localStorage.getItem('freetube-downloads') || '[]').find(d => d.createdAt >= $marker && d.status === 'downloading'); if (!item) return; clearInterval(window.__ftSmokeCancelTimer); window.dispatchEvent(new CustomEvent('android-download-control', { detail: { id: item.downloadId, action: 'cancel' } })); }, 10); true" >/dev/null || return 1
  cdp_click_sabr_option '1440p (SABR)' || return 1
  open_downloads_cdp || return 1
  id=$(cdp_latest_download_id_since "$marker")
  [[ -n "$id" && "$id" != null ]] || return 1
  cdp_wait_status "$id" canceled || return 1
  cdp_wait_inactive "$id" || return 1
  cdp_cleanup_download "$id" || return 1
  contents_after=$(cdp_eval 'window.__ftTest.offlineContents()')
  cdp_eval "Promise.all($contents_after.filter(uri => !($contents_before).includes(uri)).map(uri => window.__ftTest.removeOffline(uri)))" >/dev/null || return 1
  [[ $(cdp_eval 'window.__ftTest.offlineContents()') == "$contents_before" ]] || return 1
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
  run_test downloads-selection-ui downloads_selection_ui
  run_test download-quality download_quality
  run_test download-sabr-telemetry download_sabr_telemetry
  run_test download-sabr-pause-resume download_sabr_pause_resume
  run_test download-notification download_notification
  run_test download-sabr-export download_sabr_export
  run_test download-cancel download_cancel
  run_test download-retry download_retry
  run_test download-delete download_delete
  run_test download-saf-revoked download_saf_revoked
  run_test download-bulk-delete download_bulk_delete
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
  run_test downloads-selection-ui downloads_selection_ui
  run_test download-quality download_quality
  run_test download-sabr-telemetry download_sabr_telemetry
  run_test download-sabr-total download_sabr_total
  run_test download-sabr-quality-totals download_sabr_quality_totals
  run_test download-sabr-quality-pair download_sabr_quality_pair
  run_test download-sabr-1080 download_sabr_1080
  run_test download-sabr-ui-progress download_sabr_ui_progress
  run_test download-sabr-pause-resume download_sabr_pause_resume
  run_test download-notification download_notification
  run_test download-notification-title download_notification_title
  run_test download-notification-terminal download_notification_terminal
  run_test download-sabr-export download_sabr_export
  run_test download-cancel download_cancel
  run_test download-retry download_retry
  run_test download-delete download_delete
  run_test download-saf-revoked download_saf_revoked
  run_test download-bulk-delete download_bulk_delete
  run_test download-restart-queued download_restart_queued
  run_test download-offline-playback download_offline_playback
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

if [[ "$TEST" != preflight ]]; then
  preflight || { echo 'FAIL: APK preflight failed'; exit 1; }
fi

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
  downloads-selection-ui) run_test downloads-selection-ui downloads_selection_ui ;;
  download-quality) run_test download-quality download_quality ;;
  download-sabr-telemetry) run_test download-sabr-telemetry download_sabr_telemetry ;;
  download-sabr-total) run_test download-sabr-total download_sabr_total ;;
  download-sabr-quality-totals) run_test download-sabr-quality-totals download_sabr_quality_totals ;;
  download-sabr-quality-pair) run_test download-sabr-quality-pair download_sabr_quality_pair ;;
  download-sabr-quality-repeats|download-sabr-quality-once) run_test "$TEST" download_sabr_quality_repeats ;;
  download-sabr-1080) run_test download-sabr-1080 download_sabr_1080 ;;
  download-sabr-ui-progress) run_test download-sabr-ui-progress download_sabr_ui_progress ;;
  download-sabr-pause-resume) run_test download-sabr-pause-resume download_sabr_pause_resume ;;
  download-notification) run_test download-notification download_notification ;;
  download-notification-title) run_test download-notification-title download_notification_title ;;
  download-notification-terminal) run_test download-notification-terminal download_notification_terminal ;;
  download-sabr-export) run_test download-sabr-export download_sabr_export ;;
  download-storage) run_test download-storage download_storage ;;
  download-cancel) run_test download-cancel download_cancel ;;
  download-delete) run_test download-delete download_delete ;;
  download-saf-revoked) run_test download-saf-revoked download_saf_revoked ;;
  download-bulk-delete) run_test download-bulk-delete download_bulk_delete ;;
  download-restart-queued) run_test download-restart-queued download_restart_queued ;;
  download-retry) run_test download-retry download_retry ;;
  download-missing-source) run_test download-missing-source download_missing_source ;;
  user-playlist) run_test user-playlist user_playlist ;;
  android-navigation) run_test android-navigation android_navigation ;;
  online-playlist) run_test online-playlist online_playlist ;;
  download-selected-directory) run_test download-selected-directory download_selected_directory ;;
  download-offline-playback) run_test download-offline-playback download_offline_playback ;;
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
