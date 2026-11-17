#!/bin/bash
# Installs pingme on this Mac: builds it, puts it in ~/Applications, starts it now and at every login,
# connects the coding agents it finds (Claude Code, Codex, Cursor) to its local MCP server and adds the
# Claude Code Stop hook. Safe to run again: every step replaces what an earlier run set up.
# After it, the island at the top of the screen shows "Připojit tento Mac": the person clicks it and
# approves this Mac in the browser. An agent never approves anything.
set -euo pipefail
cd "$(dirname "$0")"

if ! xcode-select -p >/dev/null 2>&1 || ! command -v swift >/dev/null 2>&1; then
  echo "pingme needs the Xcode Command Line Tools. Run: xcode-select --install  then run ./mac/install.sh again." >&2
  exit 1
fi
if [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 15 ]; then
  echo "pingme needs macOS 15 or newer." >&2
  exit 1
fi

./build.sh

LABEL=cz.dominik.pingme
DEST="$HOME/Applications/pingme.app"
BIN="$DEST/Contents/MacOS/Pingme"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# Only the app itself (no arguments): agents' running "Pingme mcp" servers keep working.
pkill -xf "$BIN" 2>/dev/null || true
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
rm -rf "$DEST"
cp -R "build/pingme.app" "$DEST"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$BIN</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>ProcessType</key><string>Interactive</string>
	<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed and started: $DEST"

# Local MCP server "pingme" for the coding agents that exist here. Remove first, then add: idempotent.
find_tool() {
  local name="$1" p
  p="$(command -v "$name" 2>/dev/null || true)"
  [ -z "$p" ] && for c in "$HOME/.local/bin/$name" /opt/homebrew/bin/"$name" /usr/local/bin/"$name"; do
    [ -x "$c" ] && { p="$c"; break; }
  done
  printf '%s' "$p"
}

CLAUDE="$(find_tool claude)"
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" mcp remove --scope user pingme >/dev/null 2>&1 || true
  if "$CLAUDE" mcp add --scope user pingme -- "$BIN" mcp >/dev/null 2>&1; then
    echo "Claude Code: MCP server pingme added."
  else
    echo "Claude Code: could not add the MCP server. Run: claude mcp add --scope user pingme -- \"$BIN\" mcp" >&2
  fi
fi

CODEX="$(find_tool codex)"
if [ -n "$CODEX" ]; then
  "$CODEX" mcp remove pingme >/dev/null 2>&1 || true
  if "$CODEX" mcp add pingme -- "$BIN" mcp >/dev/null 2>&1; then
    echo "Codex: MCP server pingme added."
  else
    echo "Codex: could not add the MCP server. Run: codex mcp add pingme -- \"$BIN\" mcp" >&2
  fi
fi

if [ -d "$HOME/.cursor" ] || [ -d /Applications/Cursor.app ] || [ -d "$HOME/Applications/Cursor.app" ]; then
  mkdir -p "$HOME/.cursor"
  CURSOR_MCP="$HOME/.cursor/mcp.json"
  [ -f "$CURSOR_MCP" ] && [ ! -f "$CURSOR_MCP.before-pingme" ] && cp "$CURSOR_MCP" "$CURSOR_MCP.before-pingme"
  if /usr/bin/python3 -I - "$CURSOR_MCP" "$BIN" <<'PY'
import json, os, sys
path, binary = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except ValueError:
        sys.exit("not valid JSON")
if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
    sys.exit("unexpected shape")
data.setdefault("mcpServers", {})["pingme"] = {"command": binary, "args": ["mcp"]}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
PY
  then
    echo "Cursor: MCP server pingme added."
  else
    echo "Cursor: left ~/.cursor/mcp.json alone. Add {\"command\": \"$BIN\", \"args\": [\"mcp\"]} as mcpServers.pingme." >&2
  fi
fi

# Claude Code Stop hook: pings the island when a session finishes while you are elsewhere.
mkdir -p "$HOME/.local/bin"
install -m 755 Resources/pingme-hook.sh "$HOME/.local/bin/pingme-hook"
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  [ -f "$SETTINGS.before-pingme" ] || cp "$SETTINGS" "$SETTINGS.before-pingme"
  /usr/bin/python3 -I - "$SETTINGS" <<'PY'
import json, os, sys
p = sys.argv[1]
with open(p) as f:
    d = json.load(f)
hooks = d.setdefault("hooks", {})
stop = [g for g in hooks.get("Stop", []) if not any("pingme-hook" in h.get("command", "") for h in g.get("hooks", []))]
stop.append({"hooks": [{"type": "command", "command": "~/.local/bin/pingme-hook", "async": True}]})
hooks["Stop"] = stop
# A reply from the island arrives as a message from another process; deliver it without holding it.
d["crossSessionInbound"] = "accept"
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, p)
PY
  echo "Claude Code Stop hook installed."
fi

echo "Next: the pingme island at the top of the screen shows \"Připojit tento Mac\". Ask your human to click it"
echo "and approve this Mac in the browser. Until then the pingme MCP tools answer that this Mac is not connected."
