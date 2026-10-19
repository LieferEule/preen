#!/bin/zsh
# Generates the test videos in src-tauri/tests/fixtures.
# Usage: scripts/make-video-fixtures.sh src-tauri/tests/fixtures
#
# ffmpeg is only the tool that makes these files once; Preen itself never
# calls it. The pictures move and carry grain on purpose: a flat test card
# compresses to nothing, and then a size limit is never hard to meet.
set -e
out=${1:?Zielordner fehlt}
mkdir -p "$out"

# 1600x900, 60 fps, 4 s, with a sound track — wider than the content preset,
# faster than 30 fps, and audio that has to go.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1600x900:rate=60:duration=4,noise=alls=12:allf=t" \
  -f lavfi -i "sine=frequency=440:duration=4" \
  -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -shortest \
  "$out/bewegt-1600x900-60fps.mp4"

# Stored 640x360, shown rotated by 90° — the way phones record portrait.
# Rotation is set while copying the stream: given to an encode, ffmpeg
# would turn the pixels themselves and leave no rotation behind.
tmp=$(mktemp -d)
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=2,noise=alls=12:allf=t" \
  -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p \
  "$tmp/quer.mp4"
ffmpeg -v error -y -display_rotation 90 -i "$tmp/quer.mp4" -c copy \
  "$out/hochkant-gedreht.mp4"
rm -r "$tmp"

ls -l "$out"/*.mp4
