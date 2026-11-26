#!/usr/bin/env bash
# 0654 video copies: puts ffmpeg and ffprobe next to hon-api on Render's native Node runtime, which has no package
# manager. Each binary is a fixed release asset checked against its SHA-256 before it is unpacked; any mismatch or
# missing feature fails the build. The copy job stays off until HON_MEDIA_VIDEO_COPIES_APPROVED=true, and it finds these
# through HON_FFMPEG_PATH / HON_FFPROBE_PATH (render.yaml). Nothing here touches the database, storage or any account.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${HON_VIDEO_TOOLS_DIR:-$ROOT/apps/api/.video-tools}"
RELEASE="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
# name|asset|sha256 of the .gz asset (linux x64, static, GPL build)
TOOLS=(
  "ffmpeg|ffmpeg-linux-x64.gz|bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa"
  "ffprobe|ffprobe-linux-x64.gz|25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067"
)

[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "install-video-tools: only linux x86_64 is pinned" >&2; exit 1; }
mkdir -p "$DEST"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

for entry in "${TOOLS[@]}"; do
  IFS='|' read -r name asset sum <<<"$entry"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 -o "$WORK/$asset" "$RELEASE/$asset"
  echo "$sum  $WORK/$asset" | sha256sum --check --quiet - || { echo "install-video-tools: $asset checksum mismatch" >&2; exit 1; }
  gunzip -c "$WORK/$asset" >"$WORK/$name"
  chmod 0755 "$WORK/$name"
  mv -f "$WORK/$name" "$DEST/$name"
done

# The copy job needs exactly these: H.264, AAC and JPEG encoders, the mov/matroska demuxers and https input.
"$DEST/ffprobe" -hide_banner -version >/dev/null
# Each list is captured first and then searched. Piping ffmpeg straight into "grep -q" under pipefail fails the check
# whenever grep finds its line early and closes the pipe (ffmpeg then exits on SIGPIPE), which is what the first Render
# build hit ("libx264 missing" on a build that has it).
ENCODERS="$("$DEST/ffmpeg" -hide_banner -encoders 2>/dev/null)"
DEMUXERS="$("$DEST/ffmpeg" -hide_banner -demuxers 2>/dev/null)"
PROTOCOLS="$("$DEST/ffmpeg" -hide_banner -protocols 2>/dev/null)"
grep -Eq '^ V.{5} libx264 ' <<<"$ENCODERS" || { echo "install-video-tools: libx264 missing" >&2; exit 1; }
grep -Eq '^ A.{5} aac ' <<<"$ENCODERS" || { echo "install-video-tools: aac missing" >&2; exit 1; }
grep -Eq '^ V.{5} mjpeg ' <<<"$ENCODERS" || { echo "install-video-tools: mjpeg missing" >&2; exit 1; }
grep -Eq ' mov,mp4' <<<"$DEMUXERS" || { echo "install-video-tools: mov demuxer missing" >&2; exit 1; }
grep -Eq ' matroska,webm' <<<"$DEMUXERS" || { echo "install-video-tools: matroska demuxer missing" >&2; exit 1; }
grep -Eq '^ +https$' <<<"$PROTOCOLS" || { echo "install-video-tools: https input missing" >&2; exit 1; }
echo "install-video-tools: ffmpeg and ffprobe ready in $DEST"
