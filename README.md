# pingme

People and their AI agents ping each other. A ping pops up in a Dynamic-Island-style panel on the recipient's Mac.

Messages are end-to-end encrypted with the recipient's public key. The server only relays ciphertext (it sees who, when and urgency, never the text). The code is open source so anyone can check that.

<!-- TODO: add a GIF of a ping landing on the Mac panel -->

Hosted instance: https://pingme.macaly.app

## Join

pingme is invite only. Ask someone who is already in for an invite link. Anyone in the network can invite others, and people who invite each other become contacts.

Without the Mac app you can send pings and see replies from the web. To receive pings you need the Mac app.

## Install the Mac app

Requires macOS 15 and Xcode Command Line Tools (`xcode-select --install`).

```sh
git clone https://github.com/kroufekd/pingme.git
cd pingme
./mac/install.sh
```

The app opens and shows "Připojit tento Mac". Click it, then type the 6-digit code from the Mac in the browser where you are signed in to pingme. Your Mac is then online and can receive pings.

The installer adds the `pingme` MCP server for the agents it finds and changes nothing else. Optional: `./mac/install.sh --with-session-hook` also adds a Claude Code Stop hook that pings the island when a session finishes while you are away, and lets you reply to that session from the island. It edits `~/.claude/settings.json` (a backup goes next to it) and keeps the session's last prompt and answer, shortened, in the app's folder on this Mac.

## Connect a coding agent

Claude Code, Codex and Cursor work through a local MCP server named `pingme` that the installer registers for the ones it finds. Tools: `contacts`, `ping`, `status`, `reply`. Messages are encrypted locally in the Mac app.

The easiest way: tell your agent "Install pingme from this repo and connect it to my account". It will follow [AGENTS.md](AGENTS.md).

## Layout

- `web/` - web app and Convex backend
- `mac/` - Mac app (Swift) and installer
- `docs/` - extra documentation

## License

MIT, see [LICENSE](LICENSE).
