#!/usr/bin/env bash
# Builds reel.mp4 from a ship run: for each test in report order, a title card (scenario title, viewport, short SHA),
# then its clip. Every piece is scaled and padded onto one 1440x900 canvas. Needs ffmpeg, node and a TrueType font.
# Usage: ship-reel.sh <report.json> <results-dir> <sha> <out.mp4>
set -euo pipefail

report=$1 results=$2 sha=$3 out=$4
here=$(cd "$(dirname "$0")" && pwd)
font=${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}
W=1440 H=900 FPS=25
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

n=0
: > "$work/list.txt"
while IFS=$'\t' read -r project title video; do
  n=$((n + 1))
  case $project in
    ship-desktop) view="Desktop 1440x900" ;;
    ship-phone) view="Phone 390x844" ;;
    *) view=$project ;;
  esac
  # Text goes through files, never into the filter string, so a title can't break or inject into it.
  # One file and one drawtext per wrapped line: a line break inside drawtext's text renders as a box with Ubuntu's
  # ffmpeg (text shaping on), and fold -s leaves a trailing space. Lines are trimmed and centred one by one.
  mapfile -t lines < <(printf '%s\n' "$title" | fold -s -w 34 | sed 's/[[:space:]]*$//')
  count=${#lines[@]}
  filter=""
  for i in "${!lines[@]}"; do
    printf '%s' "${lines[$i]}" > "$work/title-$n-$i.txt"
    y=$(( H / 2 - 40 + (2 * i - count + 1) * 36 ))
    filter+="drawtext=expansion=none:fontfile=$font:textfile=$work/title-$n-$i.txt:fontcolor=white:fontsize=52:x=(w-text_w)/2:y=$y-text_h/2,"
  done
  printf '%s' "$view" > "$work/view-$n.txt"
  printf '%s' "${sha:0:7}" > "$work/sha-$n.txt"
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=0x111111:s=${W}x${H}:d=2:r=$FPS" \
    -vf "${filter}drawtext=expansion=none:fontfile=$font:textfile=$work/view-$n.txt:fontcolor=0xbbbbbb:fontsize=32:x=(w-text_w)/2:y=h-200,drawtext=expansion=none:fontfile=$font:textfile=$work/sha-$n.txt:fontcolor=0x888888:fontsize=28:x=(w-text_w)/2:y=h-150,format=yuv420p" \
    -an -c:v libx264 -preset veryfast "$work/card-$n.mp4"
  ffmpeg -nostdin -loglevel error -y -i "$results/$video" \
    -vf "scale=$W:$H:force_original_aspect_ratio=decrease,pad=$W:$H:(ow-iw)/2:(oh-ih)/2:color=0x111111,fps=$FPS,format=yuv420p" \
    -an -c:v libx264 -preset veryfast "$work/clip-$n.mp4"
  printf "file '%s'\nfile '%s'\n" "$work/card-$n.mp4" "$work/clip-$n.mp4" >> "$work/list.txt"
done < <(node "$here/ship-report.mjs" list "$report")

[ "$n" -gt 0 ] || { echo "::error::no tests in the report, no reel" >&2; exit 1; }
ffmpeg -nostdin -loglevel error -y -f concat -safe 0 -i "$work/list.txt" -c copy -movflags +faststart "$out"
echo "reel: $n scenarios -> $out"
