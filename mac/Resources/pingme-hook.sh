#!/bin/bash
# pingme: Claude Code Stop hook. When a session finishes while the Claude app is not in front,
# it drops a small file for the pingme island: session id, project folder, the last message and
# the owner's last prompt (both shortened, for the one-line recap) and the session's inbox socket,
# so a reply from the island can go back in.
[ -n "$PINGME_TRIAGE" ] && exit 0
in=$(cat)
front=$(/usr/bin/lsappinfo info -only bundleid "$(/usr/bin/lsappinfo front)" 2>/dev/null)
case "$front" in *com.anthropic.claudefordesktop*) exit 0 ;; esac
INBOX="$HOME/Library/Application Support/pingme/inbox"
[ -d "$INBOX" ] || exit 0
printf '%s' "$in" | /usr/bin/python3 -I -c '
import json, os, sys, tempfile
d = json.load(sys.stdin)
if d.get("stop_hook_active"):
    sys.exit(0)
def last_ask(path):
    # The last prompt of the owner: the newest real user line in the transcript tail.
    home = os.path.realpath(os.path.expanduser("~/.claude/projects")) + os.sep
    try:
        path = os.path.realpath(path)
        if not path.startswith(home) or not path.endswith(".jsonl"):
            return ""
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - 2000000))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return ""
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain") or e.get("isCompactSummary"):
            continue
        c = (e.get("message") or {}).get("content")
        if isinstance(c, list):
            if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
                continue
            c = " ".join(x.get("text") or "" for x in c if isinstance(x, dict) and x.get("type") == "text")
        if not isinstance(c, str):
            continue
        c = c.strip()
        if c and not c.startswith("<"):
            return c[:800]
    return ""
sid = str(d.get("session_id") or "")
if not sid or len(sid) > 64 or not all(c.isalnum() or c == "-" for c in sid):
    sys.exit(0)
out = {
    "session_id": sid,
    "cwd": d.get("cwd") or "",
    "last": (d.get("last_assistant_message") or "")[:2000],
    "ask": last_ask(str(d.get("transcript_path") or "")),
    "socket": os.environ.get("CLAUDE_CODE_MESSAGING_SOCKET") or "",
    "token": os.environ.get("CLAUDE_CODE_MESSAGING_TOKEN") or "",
}
inbox = sys.argv[1]
os.umask(0o077)
fd, tmp = tempfile.mkstemp(dir=inbox, suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(out, f, ensure_ascii=False)
os.replace(tmp, os.path.join(inbox, sid + ".json"))
' "$INBOX"
exit 0
