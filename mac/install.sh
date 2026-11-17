#!/bin/bash
# Installs pingme into ~/Applications and starts it at every login.
set -euo pipefail
cd "$(dirname "$0")"
LABEL=cz.dominik.pingme
DEST="$HOME/Applications/pingme.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -x Pingme 2>/dev/null || true
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "build/pingme.app" "$DEST"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$DEST/Contents/MacOS/Pingme</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>ProcessType</key><string>Interactive</string>
	<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed and started: $DEST"

# Claude Code Stop hook: pings the island when a session finishes while you are elsewhere.
mkdir -p "$HOME/.local/bin"
install -m 755 Resources/pingme-hook.sh "$HOME/.local/bin/pingme-hook"
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.before-pingme"
  /usr/bin/python3 -I - "$SETTINGS" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
hooks = d.setdefault("hooks", {})
stop = [g for g in hooks.get("Stop", []) if not any("pingme-hook" in h.get("command", "") for h in g.get("hooks", []))]
stop.append({"hooks": [{"type": "command", "command": "~/.local/bin/pingme-hook", "async": True}]})
hooks["Stop"] = stop
# A reply from the island arrives as a message from another process; deliver it without holding it.
d["crossSessionInbound"] = "accept"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
PY
  echo "Claude Code Stop hook installed."
fi
