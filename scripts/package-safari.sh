#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT=${1:-"$ROOT/build/safari"}
BUNDLE_IDENTIFIER=gpl.bramtechs.focus

if ! PACKAGER=$(xcrun --find safari-web-extension-packager 2>/dev/null); then
  if ! PACKAGER=$(xcrun --find safari-web-extension-converter 2>/dev/null); then
    printf '%s\n' \
      "Safari's extension packager was not found. Install the full Xcode app, then run this script again." >&2
    exit 1
  fi
fi

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/focus-safari.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT HUP INT TERM

mkdir -p "$STAGING/icons"
cp "$ROOT/manifest.json" "$STAGING/"
cp "$ROOT/background.js" "$ROOT/blocked.html" "$ROOT/blocked.js" "$STAGING/"
cp "$ROOT/options.html" "$ROOT/options.js" "$ROOT/popup.html" "$ROOT/popup.js" "$STAGING/"
cp "$ROOT/styles.css" "$STAGING/"
cp "$ROOT/icons/"*.png "$STAGING/icons/"

mkdir -p "$(dirname -- "$OUTPUT")"

"$PACKAGER" "$STAGING" \
  --project-location "$OUTPUT" \
  --app-name Focus \
  --bundle-identifier "$BUNDLE_IDENTIFIER" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force

# The converter capitalizes the host app's final identifier component from the
# app name, but the embedded extension must share the exact lowercase prefix.
PROJECT_FILE="$OUTPUT/Focus/Focus.xcodeproj/project.pbxproj"
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = .*\\.Focus;/PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE_IDENTIFIER;/" "$PROJECT_FILE"

printf '%s\n' "Safari project created at $OUTPUT"
