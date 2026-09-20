#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT=${1:-"$ROOT/build/safari"}
: "${BUNDLE_IDENTIFIER:?Set BUNDLE_IDENTIFIER to a unique reverse-DNS identifier ending in .Focus, for example com.example.Focus}"

case "$BUNDLE_IDENTIFIER" in
  *.Focus) ;;
  *)
    printf '%s\n' "BUNDLE_IDENTIFIER must end in .Focus so the host app and extension identifiers share a prefix." >&2
    exit 1
    ;;
esac

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
# Safari supports the options page but not this Firefox-specific display preference.
plutil -remove options_ui.open_in_tab "$STAGING/manifest.json"

mkdir -p "$(dirname -- "$OUTPUT")"

if [ -e "$OUTPUT" ]; then
  printf '%s\n' "Output already exists: $OUTPUT. Choose a new location or remove it before regenerating." >&2
  exit 1
fi

"$PACKAGER" "$STAGING" \
  --project-location "$OUTPUT" \
  --app-name Focus \
  --bundle-identifier "$BUNDLE_IDENTIFIER" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt

printf '%s\n' "Safari project created at $OUTPUT"
