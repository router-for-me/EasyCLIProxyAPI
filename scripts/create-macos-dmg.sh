#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <staging-directory> <output.dmg>" >&2
  exit 2
fi

staging_dir="$1"
output_dmg="$2"
test -d "$staging_dir"
output_dmg="$(cd "$(dirname "$output_dmg")" && pwd)/$(basename "$output_dmg")"

# Keep Spotlight off the image too, including when it is mounted during creation.
touch "$staging_dir/.metadata_never_index"

cleanup_failed_image() {
  local devices device
  # Only detach volumes belonging to this output image, never unrelated disks.
  if devices="$(hdiutil info -plist | python3 -c '
import os, plistlib, sys
output = os.path.realpath(sys.argv[1])
for image in plistlib.load(sys.stdin.buffer).get("images", []):
    if os.path.realpath(image.get("image-path", "")) == output:
        for entity in image.get("system-entities", []):
            if entity.get("mount-point") and entity.get("dev-entry"):
                print(entity["dev-entry"])
' "$output_dmg")"; then
    while IFS= read -r device; do
      [ -n "$device" ] || continue
      hdiutil detach "$device" || hdiutil detach -force "$device" || return $?
    done <<< "$devices"
  else
    echo "::warning::Could not inspect mounted images during DMG cleanup." >&2
    return 1
  fi
  rm -f "$output_dmg"
}

max_attempts=6
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  if hdiutil create -volname "EasyCLIProxyAPI" -srcfolder "$staging_dir" \
    -format UDZO -ov "$output_dmg"; then
    exit 0
  else
    create_status=$?
  fi

  if ! cleanup_failed_image; then
    echo "::error::Could not clean up the failed DMG; stopping retries." >&2
    exit "$create_status"
  fi
  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "::error::DMG creation failed after $attempt attempts (exit $create_status)." >&2
    exit "$create_status"
  fi
  delay=$((attempt * 2))
  echo "::warning::DMG creation failed (exit $create_status); retrying in ${delay}s ($attempt/$max_attempts)." >&2
  sleep "$delay"
done
