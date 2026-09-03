#!/usr/bin/env bash
set -u

PERSONAL_USER_ID=0
SERIAL=""
OUTPUT="$(cd "$(dirname "$0")/.." && pwd)/tmp/android-screen-record/$(date +%Y%m%d-%H%M%S).mp4"
REMOTE="/data/local/tmp/freetube-screen-record-$$.mp4"
ADB_PID=""
FINISHED=0

usage() {
  cat <<'EOF'
Usage: _scripts/android-screen-record.sh [options]

Options:
  --serial SERIAL  adb device serial
  --output PATH    output MP4 path
  -h, --help       show help

Records at 720p and converts to 15 fps. Press Ctrl-C to stop.
EOF
}

while (($#)); do
  case "$1" in
    --serial) SERIAL="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v adb >/dev/null 2>&1 || { echo "adb is not installed" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not installed" >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ffprobe is not installed" >&2; exit 1; }

if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
[[ -n "$SERIAL" ]] || { echo "No adb device connected" >&2; exit 1; }

adb_cmd() { adb -s "$SERIAL" "$@"; }
[[ $(adb_cmd shell am get-current-user 2>/dev/null) == "$PERSONAL_USER_ID" ]] || {
  echo "Personal profile user $PERSONAL_USER_ID is required" >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT")"
RAW="$OUTPUT.raw.mp4"

finish() {
  (( FINISHED == 0 )) || return
  FINISHED=1
  trap - EXIT INT TERM
  adb_cmd shell pkill -INT screenrecord >/dev/null 2>&1 || true
  [[ -z "$ADB_PID" ]] || wait "$ADB_PID" 2>/dev/null || true
  if adb_cmd pull "$REMOTE" "$RAW" >/dev/null 2>&1; then
    adb_cmd shell rm -f "$REMOTE" >/dev/null 2>&1 || true
    if ffmpeg -loglevel error -y -i "$RAW" -vf fps=15 -an -c:v libx264 -preset veryfast -crf 30 -movflags +faststart "$OUTPUT" &&
      ffprobe -v error -select_streams v:0 -show_entries stream=index -of csv=p=0 "$OUTPUT" | grep -q .; then
      rm -f "$RAW"
      echo "Screen recording: $OUTPUT"
    else
      echo "Failed to convert screen recording: $RAW" >&2
    fi
  else
    echo "Failed to pull screen recording" >&2
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

adb_cmd shell screenrecord --size 720x1280 --bit-rate 2M --time-limit 0 "$REMOTE" >/dev/null 2>&1 &
ADB_PID=$!
echo "Recording screen on $SERIAL. Press Ctrl-C to stop."
wait "$ADB_PID" || true
