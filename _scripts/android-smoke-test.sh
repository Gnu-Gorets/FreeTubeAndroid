#!/usr/bin/env bash
set -u

PACKAGE="io.freetubeapp.freetubeandroid"
TEST_PACKAGE="$PACKAGE.test"
ACTIVITY="$PACKAGE/.MainActivity"
TEST_RUNNER="$TEST_PACKAGE/androidx.test.runner.AndroidJUnitRunner"
APK="$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/debug/app-debug.apk"
TEST_APK="$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
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
ORIENTATION_STATE_SAVED=0
ORIGINAL_ROTATION_MODE=""
ORIGINAL_USER_ROTATION=""
ORIENTATION_SETTINGS_SAVED=0
ORIGINAL_ACCELEROMETER_ROTATION=""
ORIGINAL_USER_ROTATION_SETTING=""
PROXY_PID=""
PROXY_PORT=19050
PROXY_LOG=""
QUALITY=""
QUALITY_VIDEO_ID="mXIAYbU3nQI"
EXTERNAL_PLAYER_WIFI_STATE=""
EXTERNAL_PLAYER_MOBILE_STATE=""

usage() {
  cat <<'EOF'
Usage: _scripts/android-smoke-test.sh [options]

Options:
  --serial SERIAL       adb device serial
  --apk PATH            debug APK path
  --suite NAME          unlocked, locked, all (default: all)
  --test NAME           one test: preflight, cold-start, search, reload, playback, controls,
                        lock-screen, audio-focus, persistence, cleanup, recovery,
                        locked-state, locked-notification, locked-session,
                        export, data-directory-cancel,
                        locked-controls, locked-audio-focus, locked-cleanup, locked-force-stop,
                        fullscreen-fit-screen, fullscreen-auto-rotate, long-press, settings-sort, ui-scale-layout, proxy, network-quality,
                        external_player, external_player_wifi_vlc, external_player_wifi_mpv,
                        external_player_mobile_vlc, external_player_mobile_mpv
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
    --quality) QUALITY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$ARTIFACT_DIR"
LOG_FILE="$ARTIFACT_DIR/logcat.txt"
RUN_START_SECONDS=$(date +%s)
CURRENT_TEST="setup"
TEST_START_SECONDS=$RUN_START_SECONDS
declare -a TEST_TIMINGS=()

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
screenshot() { adb_cmd exec-out screencap -p >"$ARTIFACT_DIR/$1.png"; }
is_landscape() {
  local width height
  read -r width height <<<"$(identify -format '%w %h' "$1")"
  (( width > height ))
}
dump_ui() { adb_cmd exec-out uiautomator dump /dev/tty 2>/dev/null >"$ARTIFACT_DIR/$1.xml" || true; }
log_focus() { adb_shell dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|mFocusedApp' | tail -2 || true; }
if ! command -v adb >/dev/null 2>&1; then
  echo "SKIP: adb is not installed"; exit 77
fi

if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [[ -z "$SERIAL" ]] || ! adb_cmd get-state >/dev/null 2>&1; then
  echo "SKIP: no adb device connected"; exit 77
fi
adb_cmd root >/dev/null 2>&1 || true
sleep 2

run_test() {
  local name="$1" start elapsed; shift
  CURRENT_TEST="$name"
  TEST_START_SECONDS=$(date +%s)
  echo "== $name =="
  progress "started"
  start=$TEST_START_SECONDS
  if "$@"; then
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
  local pattern="$1" start now last_log
  start=$(date +%s)
  last_log=$start
  progress "waiting for focus: $pattern (timeout ${TIMEOUT}s)"
  while :; do
    if is_focused "$pattern"; then
      progress "focus found: $pattern"
      return 0
    fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for focus: $pattern ($((now - start))s/${TIMEOUT}s)"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for focus: $pattern; artifacts: $ARTIFACT_DIR"
      return 1
    fi
    sleep 1
  done
}

wait_for_media() {
  local pattern="$1" start now last_log
  start=$(date +%s)
  last_log=$start
  progress "waiting for media: $pattern (timeout ${TIMEOUT}s)"
  while :; do
    if adb_shell dumpsys media_session 2>/dev/null | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' | grep -q "$pattern"; then
      progress "media state found: $pattern"
      return 0
    fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for media: $pattern ($((now - start))s/${TIMEOUT}s)"
      log_video_state "$((now - start))"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for media: $pattern; artifacts: $ARTIFACT_DIR"
      return 1
    fi
    sleep 1
  done
}

wait_for_mapping() {
  local pattern="$1" start now last_log
  start=$(date +%s); last_log=$start
  progress "waiting for data mapping: $pattern (timeout ${TIMEOUT}s)"
  while :; do
    if adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null | grep -q "$pattern"; then
      progress "data mapping found: $pattern"
      return 0
    fi
    now=$(date +%s)
    if ((now - last_log >= 10)); then
      progress "still waiting for data mapping: $pattern ($((now - start))s/${TIMEOUT}s)"
      last_log=$now
    fi
    if ((now - start >= TIMEOUT)); then
      progress "timeout waiting for data mapping: $pattern; artifacts: $ARTIFACT_DIR"
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
  sleep 2
}

require_unlocked() {
  wake_device
  if ! device_is_unlocked; then
    echo "SKIP: device is locked; unlocked suite requires manual unlock"
    exit 77
  fi
}

start_app() {
  adb_shell am force-stop com.android.documentsui >/dev/null 2>&1 || true
  adb_shell am force-stop --user 0 "$PACKAGE" >/dev/null 2>&1 || return 1
  adb_shell am start --user 0 -n "$ACTIVITY" >/dev/null 2>&1 || return 1
  wait_for "$PACKAGE" || return 1
  close_picker || return 1
  sleep 5
}

log_video_state() {
  local elapsed="$1"
  adb_shell am start -a io.freetubeapp.freetubeandroid.TEST_SMOKE_ACTION \
    --es action video_state -n "$ACTIVITY" >/dev/null 2>&1 || return 0
  sleep 1
  adb_cmd logcat -d -v brief | grep -E 'SMOKE_(DEEP_LINK|VIDEO_STATE)' | tail -20 \
    | tee -a "$ARTIFACT_DIR/video-state.log" >&2
  adb_shell dumpsys media_session | grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' \
    >"$ARTIFACT_DIR/media-$elapsed.txt" || true
}

screen_fingerprint() {
  local path="$1"
  adb_cmd exec-out screencap -p | sha256sum | cut -d' ' -f1 >"$path"
}

wait_for_screen_change() {
  local before="$1" start now current
  start=$(date +%s)
  while :; do
    current=$(mktemp)
    screen_fingerprint "$current"
    if [[ "$(cat "$current")" != "$(cat "$before")" ]]; then
      rm -f "$current"
      return 0
    fi
    rm -f "$current"
    now=$(date +%s)
    ((now - start >= TIMEOUT)) && return 1
    sleep 1
  done
}

set_fit_video_to_fullscreen() {
  local desired="$1"
  open_video jNQXAC9IVRw || return 1
  run_web_smoke_action fit "$desired" || {
    echo "Fit Screen toggle did not reach target=$desired"
    return 1
  }
  screenshot "fit-screen-player-$desired"
}

save_orientation() {
  read -r ORIGINAL_ROTATION_MODE ORIGINAL_USER_ROTATION <<<"$(adb_shell wm user-rotation)"
  ORIENTATION_STATE_SAVED=1
}

set_orientation() {
  adb_shell wm user-rotation lock "$1"
  sleep 3
}

restore_orientation() {
  (( ORIENTATION_STATE_SAVED == 1 )) || return 0
  adb_shell wm user-rotation "$ORIGINAL_ROTATION_MODE" "$ORIGINAL_USER_ROTATION" >/dev/null 2>&1 || true
}

save_rotation_settings() {
  ORIGINAL_ACCELEROMETER_ROTATION=$(adb_shell settings get system accelerometer_rotation)
  ORIGINAL_USER_ROTATION_SETTING=$(adb_shell settings get system user_rotation)
  ORIENTATION_SETTINGS_SAVED=1
}

set_auto_rotate_off() {
  adb_shell settings put system accelerometer_rotation 0
  adb_shell settings put system user_rotation 0
  sleep 3
}

restore_rotation_settings() {
  (( ORIENTATION_SETTINGS_SAVED == 1 )) || return 0
  adb_shell settings put system accelerometer_rotation "$ORIGINAL_ACCELEROMETER_ROTATION" >/dev/null 2>&1 || true
  adb_shell settings put system user_rotation "$ORIGINAL_USER_ROTATION_SETTING" >/dev/null 2>&1 || true
}

no_native_crash() {
  collect_logs
  ! grep -E 'FATAL EXCEPTION|AndroidRuntime: FATAL' "$LOG_FILE" >/dev/null
}

enter_fullscreen() {
  run_web_smoke_action fullscreen || return 1
  sleep 3
}

fullscreen_auto_rotate() {
  clean_logs
  save_orientation || return 1
  save_rotation_settings || return 1
  trap 'restore_rotation_settings; restore_orientation' EXIT
  set_orientation 0 || return 1
  set_auto_rotate_off || return 1
  open_video jNQXAC9IVRw || return 1
  enter_fullscreen portrait
  screenshot fullscreen-auto-rotate
  is_landscape "$ARTIFACT_DIR/fullscreen-auto-rotate.png" || {
    echo "Fullscreen did not rotate to landscape with auto-rotate locked"
    return 1
  }
  set_orientation 3 || return 1
  screenshot fullscreen-auto-rotate-reverse
  is_landscape "$ARTIFACT_DIR/fullscreen-auto-rotate-reverse.png" || {
    echo "Fullscreen did not remain landscape after reverse rotation"
    return 1
  }
  set_orientation 0 || return 1
  adb_shell input keyevent KEYCODE_BACK
  sleep 3
  screenshot fullscreen-auto-rotate-exit
  if is_landscape "$ARTIFACT_DIR/fullscreen-auto-rotate-exit.png"; then
    echo "Fullscreen exit did not restore portrait orientation"
    return 1
  fi
  restore_rotation_settings
  restore_orientation
  trap - EXIT
  no_native_crash
}

fullscreen_fit_screen() {
  clean_logs
  save_orientation || return 1
  trap restore_orientation EXIT
  set_orientation 0 || return 1

  local setting orientation suffix
  for setting in off on; do
    set_orientation 0 || return 1
    set_fit_video_to_fullscreen "$setting" || return 1
    for orientation in landscape; do
      suffix="${setting}-${orientation}"
      open_video jNQXAC9IVRw || return 1
      set_orientation "$([[ "$orientation" == "landscape" ]] && echo 1 || echo 0)"
      enter_fullscreen "$orientation" || return 1
      screenshot "fullscreen-fit-screen-$suffix"
      if [[ "$orientation" == "landscape" ]] && ! is_landscape "$ARTIFACT_DIR/fullscreen-fit-screen-$suffix.png"; then
        echo "Unexpected fullscreen orientation for $suffix"
        return 1
      fi
      run_web_smoke_action fit_visual "$setting" || {
        echo "Unexpected video object-fit for $suffix"
        return 1
      }
      adb_shell input keyevent KEYCODE_BACK
      sleep 2
    done
  done

  restore_orientation
  trap - EXIT
  no_native_crash
}

run_web_smoke_action() {
  local action="$1" query="${2:-}" result="" marker shell_query
  marker="SMOKE_${action^^}_TEST:"
  printf -v shell_query '%q' "$query"
  adb_shell am start -a io.freetubeapp.freetubeandroid.TEST_SMOKE_ACTION \
    --es action "$action" --es query "$shell_query" -n "$ACTIVITY" >/dev/null 2>&1 || return 1
  [[ "$action" == "fullscreen" ]] && adb_shell input keyevent KEYCODE_F
  for _ in $(seq 1 "$TIMEOUT"); do
    result=$(adb_cmd logcat -d -v brief | grep "$marker" | tail -1 || true)
    [[ -n "$result" ]] && break
    sleep 1
  done
  [[ "$result" == *"${marker}PASS"* ]]
}

open_search_results() {
  start_app || return 1
  run_web_smoke_action search linux || return 1
  progress "waiting for search results (6s)"
  sleep 6
  progress "search wait finished"
}

clean_logs() { adb_cmd logcat -c; : >"$LOG_FILE"; }

trap cleanup_proxy EXIT

clear_app_proxy() {
  start_app || return 1
  run_web_smoke_action settings proxy || return 1
  sleep 2
  run_web_smoke_action proxy_off || return 1
  sleep 2
}

clear_global_proxy() {
  adb_shell settings put global http_proxy :0 >/dev/null 2>&1 || true
  adb_shell settings delete global global_http_proxy_host >/dev/null 2>&1 || true
  adb_shell settings delete global global_http_proxy_port >/dev/null 2>&1 || true
}

cleanup_proxy() {
  if [[ -n "$PROXY_PID" ]]; then
    clear_app_proxy || true
    clear_global_proxy
    adb_cmd reverse --remove "tcp:$PROXY_PORT" >/dev/null 2>&1 || true
    kill "$PROXY_PID" >/dev/null 2>&1 || true
  fi
}

proxy_settings() {
  command -v python3 >/dev/null 2>&1 || return 77
  clean_logs
  PROXY_LOG="$ARTIFACT_DIR/proxy.log"
  : >"$PROXY_LOG"
  python3 "$(dirname "$0")/android-test-http-proxy.py" "$PROXY_PORT" "$PROXY_LOG" >/dev/null 2>&1 &
  PROXY_PID=$!
  sleep 1
  adb_cmd reverse "tcp:$PROXY_PORT" "tcp:$PROXY_PORT" || return 1
  start_app || return 1
  run_web_smoke_action settings proxy || return 1
  sleep 2
  run_web_smoke_action proxy "$PROXY_PORT" || return 1
  sleep 10
  grep -q '^CONNECT ' "$PROXY_LOG" || {
    echo "Proxy did not receive Test Proxy request"
    return 1
  }
  open_video jNQXAC9IVRw || return 1
  no_native_crash
}
collect_logs() {
  adb_cmd logcat -d -v brief >"$LOG_FILE"
  adb_shell dumpsys media_session >"$ARTIFACT_DIR/media_session.txt"
  adb_shell dumpsys audio >"$ARTIFACT_DIR/audio.txt"
}
no_runtime_errors() {
  collect_logs
  ! grep -E 'FATAL EXCEPTION|Failed to fetch|TypeError:|AndroidRuntime: FATAL' "$LOG_FILE" \
    | grep -vE 'api\.invidious\.io/instances\.json|TypeError: Failed to fetch \(file:///android_asset/web\.js:2\)' >/dev/null
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

settings_sort() {
  preflight || return 1
  clean_logs
  adb_shell am force-stop "$PACKAGE"
  adb_shell am start -n "$ACTIVITY" >/dev/null 2>&1 || return 1
  wait_for "$PACKAGE" || return 1
  sleep 3
  adb_shell am start -a io.freetubeapp.freetubeandroid.TEST_SETTINGS_SORT -n "$ACTIVITY" >/dev/null 2>&1 || return 1

  local result=""
  for _ in $(seq 1 "$TIMEOUT"); do
    result=$(adb_cmd logcat -d -v brief | grep 'SETTINGS_SORT_TEST:' | tail -1 || true)
    [[ -n "$result" ]] && break
    sleep 1
  done
  screenshot settings-sort
  dump_ui settings-sort
  echo "${result:-SETTINGS_SORT_TEST:TIMEOUT}"
  [[ "$result" == *'SETTINGS_SORT_TEST:PASS'* ]]
}

open_video() {
  local video_id="${1:-jNQXAC9IVRw}"
  start_app || return 1
  adb_shell am start -a android.intent.action.VIEW \
    -d "https://www.youtube.com/watch?v=$video_id" -n "$ACTIVITY" >/dev/null 2>&1 || return 1
  wait_for_media 'metadata: size=' || return 1
  progress "starting video playback"
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null 2>&1
  wait_for_media 'state=PlaybackState {state=PLAYING' || return 1
  screenshot video
}

check_video_quality() {
  local expected="$1" state height
  for _ in $(seq 1 "$TIMEOUT"); do
    adb_shell am start -a io.freetubeapp.freetubeandroid.TEST_SMOKE_ACTION \
      --es action video_state -n "$ACTIVITY" >/dev/null 2>&1 || return 1
    sleep 1
    state=$(adb_cmd logcat -d -v brief | grep 'SMOKE_VIDEO_STATE:' | tail -1 || true)
    height=$(printf '%s' "$state" | python3 -c 'import json, sys; data=json.JSONDecoder().raw_decode(sys.stdin.read().split("SMOKE_VIDEO_STATE:", 1)[1].lstrip())[0]; print(data["height"] if data["video"] else "")' 2>/dev/null || true)
    if [[ -n "$height" && "$height" != "0" ]]; then
      progress "selected video quality: ${height}p, expected ${expected}p"
      [[ "$height" == "$expected" ]]
      return
    fi
  done
  progress "video quality check timed out"
  return 1
}

save_external_network_state() {
  EXTERNAL_PLAYER_WIFI_STATE=$(adb_shell settings get global wifi_on 2>/dev/null || true)
  EXTERNAL_PLAYER_MOBILE_STATE=$(adb_shell settings get global mobile_data 2>/dev/null || true)
}

network_is_only() {
  local expected="$1" dump wifi mobile
  dump=$(adb_shell dumpsys connectivity 2>/dev/null) || return 1
  wifi=$(grep -c 'ni{WIFI CONNECTED' <<<"$dump")
  mobile=$(grep 'ni{MOBILE.*CONNECTED' <<<"$dump" | grep -c 'Capabilities:.*INTERNET')
  if [[ "$expected" == "wifi" ]]; then
    [[ "$wifi" -gt 0 && "$mobile" -eq 0 ]]
  else
    [[ "$wifi" -eq 0 && "$mobile" -gt 0 ]]
  fi
}

set_external_network() {
  local expected="$1"
  if [[ "$expected" == "wifi" ]]; then
    adb_shell svc wifi enable
    adb_shell svc data disable
  else
    adb_shell svc wifi disable
    adb_shell svc data enable
  fi
  for _ in $(seq 1 30); do
    if network_is_only "$expected"; then
      progress "network ready: $expected only"
      return 0
    fi
    sleep 1
  done
  echo "Network setup failed: expected $expected only" >&2
  adb_shell dumpsys connectivity >&2
  return 1
}

restore_external_network_state() {
  case "$EXTERNAL_PLAYER_WIFI_STATE" in
    1) adb_shell svc wifi enable >/dev/null 2>&1 || true ;;
    0) adb_shell svc wifi disable >/dev/null 2>&1 || true ;;
  esac
  case "$EXTERNAL_PLAYER_MOBILE_STATE" in
    1) adb_shell svc data enable >/dev/null 2>&1 || true ;;
    0) adb_shell svc data disable >/dev/null 2>&1 || true ;;
  esac
}

wait_for_external_playback() {
  local player_package="$1"
  for _ in $(seq 1 "$TIMEOUT"); do
    if adb_shell dumpsys media_session 2>/dev/null \
      | grep -A20 -m1 "$player_package" \
      | grep -q 'state=PlaybackState {state=PLAYING'; then
      progress "external playback active: $player_package"
      return 0
    fi
    sleep 1
  done
  echo "External playback did not reach PLAYING: $player_package" >&2
  return 1
}

wait_for_external_audio() {
  local player_package="$1"
  for _ in $(seq 1 "$TIMEOUT"); do
    if adb_shell dumpsys audio 2>/dev/null \
      | grep -q "requestAudioFocus.*callingPack=$player_package"; then
      progress "external audio focus acquired: $player_package"
      return 0
    fi
    sleep 1
  done
  echo "External audio focus was not acquired: $player_package" >&2
  return 1
}

wait_for_external_quality() {
  local network="$1" expected="$2" state target adaptive
  for _ in $(seq 1 "$TIMEOUT"); do
    state=$(adb_cmd logcat -d -v brief \
      | grep 'stream-selected' \
      | grep "\"networkType\":\"$network\"" \
      | tail -1 || true)
    target=$(sed -n 's/.*"targetQuality":\([0-9]*\).*/\1/p' <<<"$state")
    adaptive=$(sed -n 's/.*"selectedAdaptiveHeight":\([0-9]*\).*/\1/p' <<<"$state")
    if [[ "$target" == "$expected" && "$adaptive" == "$expected" ]]; then
      progress "external quality matched: network=$network expected=${expected}p actual=${adaptive}p"
      return 0
    fi
    sleep 1
  done
  echo "External quality mismatch: network=$network expected=${expected}p state=${state:-missing}" >&2
  return 1
}

external_player_case() {
  local player_package="$1" network="$2" first_index="$3" second_index="$4"
  set_external_network "$network" || return 1
  adb_shell am force-stop --user 0 "$player_package" >/dev/null 2>&1 || true
  start_app || return 1
  run_web_smoke_action external_player "$first_index|$player_package" || return 1
  wait_for "$player_package" || return 1
  sleep 5
  adb_shell input keyevent KEYCODE_MEDIA_PAUSE
  adb_shell input keyevent KEYCODE_HOME
  sleep 2
  adb_shell am start --user 0 -n "$ACTIVITY" >/dev/null 2>&1 || return 1
  wait_for "$PACKAGE" || return 1
  run_web_smoke_action external_player "$second_index|$player_package" || return 1
  wait_for "$player_package" || return 1
  progress "check 1/3: video playback in $player_package"
  wait_for_external_playback "$player_package" || return 1
  progress "check 2/3: audio focus in $player_package"
  wait_for_external_audio "$player_package" || return 1
  progress "check 3/3: default quality for $network"
  wait_for_external_quality "$network" "$([[ "$network" == "wifi" ]] && echo 1080 || echo 480)" || return 1
  sleep 5
}

external_player_single() {
  local player_package="$1" network="$2" first_index="$3" second_index="$4" status=0
  adb_shell am force-stop --user 0 "$PACKAGE" >/dev/null 2>&1 || true
  clean_logs
  save_external_network_state
  external_player_case "$player_package" "$network" "$first_index" "$second_index" || status=1
  restore_external_network_state
  no_runtime_errors || status=1
  return "$status"
}

external_player_wifi_vlc() { external_player_single org.videolan.vlc wifi 0 1; }
external_player_wifi_mpv() { external_player_single is.xyz.mpv wifi 0 1; }
external_player_mobile_vlc() { external_player_single org.videolan.vlc mobile 0 1; }
external_player_mobile_mpv() { external_player_single is.xyz.mpv mobile 0 1; }

external_player() {
  local status=0
  external_player_wifi_vlc || status=1
  external_player_wifi_mpv || status=1
  external_player_mobile_vlc || status=1
  external_player_mobile_mpv || status=1
  return "$status"
}

network_quality() {
  [[ "$QUALITY" =~ ^(480|1080)$ ]] || { echo "--quality must be 480 or 1080" >&2; return 2; }
  clean_logs
  open_video "$QUALITY_VIDEO_ID" || return 1
  check_video_quality "$QUALITY" || return 1
  no_runtime_errors || return 1
}

playback() {
  clean_logs
  open_search_results || return 1
  open_video
  no_runtime_errors || return 1
  grep -A20 -m1 'FreeTubeAndroid io.freetubeapp.freetubeandroid' "$ARTIFACT_DIR/media_session.txt" | grep -q 'state=PlaybackState {state=PLAYING'
}

reload() {
  clean_logs
  start_app || return 1
  run_web_smoke_action reload || return 1
  screenshot reload-after
  no_native_crash
}

long_press() {
  clean_logs
  media_session | grep -q 'state=PlaybackState {state=PLAYING' || {
    open_search_results || return 1
    open_video || return 1
  }
  run_web_smoke_action long_press || return 1
  screenshot long-press
  no_native_crash
}

controls() {
  clean_logs
  media_session | grep -q 'state=PlaybackState {state=PLAYING' || {
    open_search_results || return 1
    open_video || return 1
  }
  adb_shell am start -a MEDIA_PAUSE -n "$ACTIVITY" >/dev/null 2>&1
  wait_for_media 'state=PlaybackState {state=PAUSED' || return 1
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null 2>&1
  wait_for_media 'state=PlaybackState {state=PLAYING' || return 1
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
  adb_shell am start -a MEDIA_PAUSE -n "$ACTIVITY" >/dev/null 2>&1
  sleep 2
  media_session | grep -q 'state=PlaybackState {state=PAUSED' || return 1
  adb_shell am start -a MEDIA_PLAY -n "$ACTIVITY" >/dev/null 2>&1
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
  clean_logs
  media_session | grep -q 'state=PlaybackState {state=PLAYING' || {
    open_search_results || return 1
    open_video || return 1
  }
  adb_shell dumpsys audio | grep -q "$PACKAGE" || return 1
  no_runtime_errors
}

open_data_settings() {
  start_app || return 1
  run_web_smoke_action settings data || return 1
  sleep 2
}

export_data() {
  open_data_settings || return 1
  run_web_smoke_action data_export || return 1
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  screenshot export-picker
  close_picker
}

data_directory_cancel() {
  open_data_settings || return 1
  local mapping_before mapping_after
  mapping_before=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  run_web_smoke_action data_select || return 1
  wait_for 'com.android.documentsui/.picker.PickActivity' || return 1
  close_picker || return 1
  mapping_after=$(adb_shell run-as "$PACKAGE" cat files/data/data-location.json 2>/dev/null || true)
  [[ "$mapping_before" == "$mapping_after" ]]
}

data_directory_move_reset() {
  [[ -f "$APK" ]] || { echo "APK not found: $APK"; return 1; }
  [[ -f "$TEST_APK" ]] || { echo "Test APK not found: $TEST_APK"; return 1; }
  adb_cmd install -r --user 0 "$APK" >/dev/null || return 1
  adb_cmd install -r --user 0 "$TEST_APK" >/dev/null || return 1
  adb_shell am instrument --user 0 -w -e class "$PACKAGE.CoordinateFreeSmokeTest#dataDirectoryMoveReset" "$TEST_RUNNER" \
    | tee "$ARTIFACT_DIR/data-directory-move-reset.log" \
    | grep -q 'OK'
  local status=${PIPESTATUS[0]}
  adb_cmd uninstall --user 0 "$TEST_PACKAGE" >/dev/null 2>&1 || true
  ((status == 0))
}

persistence() {
  clean_logs
  start_app || return 1
  run_web_smoke_action settings theme || return 1
  sleep 2
  run_web_smoke_action persistence_set || return 1
  local result original target
  result=$(adb_cmd logcat -d -v brief | grep 'SMOKE_PERSISTENCE_SET_TEST:' | tail -1)
  original=$(sed -n 's/.*SMOKE_PERSISTENCE_SET_TEST:PASS:\([0-9]*\):\([0-9]*\).*/\1/p' <<<"$result")
  target=$(sed -n 's/.*SMOKE_PERSISTENCE_SET_TEST:PASS:\([0-9]*\):\([0-9]*\).*/\2/p' <<<"$result")
  [[ "$result" == *'SMOKE_PERSISTENCE_SET_TEST:PASS:'* && "$original" =~ ^[0-9]+$ && "$target" =~ ^[0-9]+$ ]] || return 1
  screenshot persistence-before-restart
  adb_shell am force-stop "$PACKAGE"
  start_app || return 1
  run_web_smoke_action settings theme || return 1
  sleep 2
  run_web_smoke_action persistence_check "$target:$original" || return 1
  screenshot persistence-after-restart
}

check_ui_scale_layout() {
  local scale="$1" layout="$2"
  clean_logs
  start_app || return 1
  run_web_smoke_action settings theme || return 1
  sleep 2
  run_web_smoke_action persistence_set "$scale" || return 1
  sleep 5
  clean_logs
  start_app || return 1
  run_web_smoke_action settings theme || return 1
  sleep 2
  run_web_smoke_action scale_layout "$scale:$layout" || return 1
  adb_cmd logcat -d -v brief | grep 'SMOKE_SCALE_LAYOUT_TEST:' | tail -1
  screenshot "ui-scale-$scale"
}

ui_scale_layout() {
  preflight || return 1
  local status=0 scale layout
  for scale in 100 105 115 90; do
    layout="$([[ "$scale" -ge 100 ]] && echo mobile || echo unchanged)"
    check_ui_scale_layout "$scale" "$layout" || status=1
  done
  clean_logs
  start_app && run_web_smoke_action settings theme && sleep 2 && run_web_smoke_action persistence_set 100 || status=1
  sleep 5
  return "$status"
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
  run_test reload reload
  run_test playback playback
  run_test long-press long_press
  run_test controls controls
  run_test audio-focus audio_focus
  run_test persistence persistence
  run_test external_player external_player
  run_test export export_data
  run_test data-directory-cancel data_directory_cancel
  run_test data-directory-move-reset data_directory_move_reset
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
  reload) run_test reload reload ;;
  playback) run_test playback playback ;;
  network-quality) run_test network-quality network_quality ;;
  external_player) run_test external_player external_player ;;
  external_player_wifi_vlc) run_test external_player_wifi_vlc external_player_wifi_vlc ;;
  external_player_wifi_mpv) run_test external_player_wifi_mpv external_player_wifi_mpv ;;
  external_player_mobile_vlc) run_test external_player_mobile_vlc external_player_mobile_vlc ;;
  external_player_mobile_mpv) run_test external_player_mobile_mpv external_player_mobile_mpv ;;
  long-press) run_test long-press long_press ;;
  controls) run_test controls controls ;;
  fullscreen-fit-screen) run_test fullscreen-fit-screen fullscreen_fit_screen ;;
  fullscreen-auto-rotate) run_test fullscreen-auto-rotate fullscreen_auto_rotate ;;
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
  cleanup) run_test cleanup cleanup ;;
  recovery) run_test recovery recovery ;;
  settings-sort) run_test settings-sort settings_sort ;;
  ui-scale-layout) run_test ui-scale-layout ui_scale_layout ;;
  proxy) run_test proxy proxy_settings ;;
  *) echo "Unknown test: $TEST" >&2; usage >&2; exit 2 ;;
esac

collect_logs
{
  printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
  printf 'TIMINGS %s\n' "${TEST_TIMINGS[*]}"
} | tee "$ARTIFACT_DIR/summary.txt"
if ((FAIL > 0)); then exit 1; fi
exit 0
