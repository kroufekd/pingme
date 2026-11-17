#!/bin/bash
# Builds pingme.app into build/. Usage: ./build.sh [web-url]
# Env, all optional: WEB_URL (pairing page and invite links), API_URL (the deployment's HTTP actions,
# /device/*), CONVEX_URL (the Convex deployment for the live feed). Defaults: the hosted pingme.
# No secrets go into the app: its device token is made when the Mac is paired and lives in the Keychain.
set -euo pipefail
cd "$(dirname "$0")"
WEB_URL="${1:-${WEB_URL:-https://pingme.macaly.app}}"
API_URL="${API_URL:-https://amiable-magpie-936.convex.site}"
CONVEX_URL="${CONVEX_URL:-https://amiable-magpie-936.convex.cloud}"
APP="build/pingme.app"
mkdir -p .build
LOG=.build/pingme-build.log
# The Convex binary is built for a newer macOS than our minimum; those linker notes are harmless.
if ! swift build -c release --product Pingme >"$LOG" 2>&1; then
  grep -v "was built for newer" "$LOG" | tail -40 >&2
  exit 1
fi
grep -E "warning:|Build complete" "$LOG" | grep -v "was built for newer" || true
BIN="$(swift build -c release --show-bin-path)/Pingme"
[ -x "$BIN" ] || { echo "Build failed: $BIN missing" >&2; exit 1; }
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/icons" "$APP/Contents/Resources/fonts" build/AppIcon.iconset
cp "$BIN" "$APP/Contents/MacOS/Pingme"
cp Resources/Info.plist "$APP/Contents/"
cp Resources/icons/*.svg "$APP/Contents/Resources/icons/"
cp Resources/fonts/* "$APP/Contents/Resources/fonts/"
cp Resources/pingme-hook.sh "$APP/Contents/Resources/"
/usr/bin/python3 -I -c 'import json,sys; print(json.dumps({"api":sys.argv[1],"web":sys.argv[2],"convex":sys.argv[3]}))' \
  "$API_URL" "$WEB_URL" "$CONVEX_URL" > "$APP/Contents/Resources/config.json"
for s in 16 32 128 256 512; do
  "$APP/Contents/MacOS/Pingme" --render-icon "build/AppIcon.iconset/icon_${s}x${s}.png" $s
  "$APP/Contents/MacOS/Pingme" --render-icon "build/AppIcon.iconset/icon_${s}x${s}@2x.png" $((s*2))
done
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "OK: $APP"
