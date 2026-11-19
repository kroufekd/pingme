# pingme

Pings between people and their AI agents, delivered to the island under your Mac's notch.

End-to-end encrypted and open source. Pretty Good Privacy, for you, me and our agents.

- **People** ping you from the web. The ping drops into the island with its urgency (Can wait, Soon, Now) and you reply right there.
- **Agents** (Claude Code, Codex, Cursor) ping you or your contacts through a local MCP server and read the reply when it comes.
- **Sessions** (optional): when a Claude Code session finishes while you are away and waits on you (a question, an approval, a login), the island says what it needs, and you can answer the session from the island. A session that only reports stays quiet.

Hosted instance: [pingme.macaly.app](https://pingme.macaly.app). It is invite only: ask someone who is in for a link.

## How it works

```
 sender (web or agent)           server (Convex)              your Mac
 ─────────────────────          ─────────────────            ──────────
 seal text to each of   ──►     stores ciphertext,   ──►     opens it with its
 your devices' keys             who, when, urgency            private key, shows
                                                              it on the island
```

- Every device has its own key pair. A Mac keeps its private key in the Keychain, a browser in IndexedDB. Private keys never leave the device.
- Pings and replies are sealed with HPKE (RFC 9180: X25519, HKDF-SHA256, ChaCha20-Poly1305) to every device of the recipient, one envelope each. The server relays envelopes and never sees the text.
- The server does see who pings whom, when, the urgency and the delivery status (queued, on the Mac, seen, replied). That is what it needs to deliver and to show status.
- Pairing a Mac: the Mac makes its key and opens the pairing page. You sign in there and type the 6-digit code shown on your Mac. The code is derived from the Mac's public key, so a pairing link someone sends you cannot add their Mac to your account.
- Contacts are people who invited each other. You can ping your contacts and yourself, nobody else.

The full protocol, with every endpoint and limit, is in [docs/device-api.md](docs/device-api.md).

## Get started

1. Open your invite link and sign in with your email (a 6-digit code arrives by mail).
2. Install the Mac app (below), click **Connect this Mac** on the island, sign in on the page that opens and type the code from the island.
3. Send a ping. Invite people from the web or from the island (People, Invite).

Without the Mac app you can still send pings and read replies on the web. To receive pings you need the Mac app.

## Install the Mac app

Requires macOS 14 or later and the Xcode Command Line Tools (`xcode-select --install`).

```sh
git clone https://github.com/kroufekd/pingme.git
cd pingme
./mac/install.sh
```

The installer builds the app, puts it in `~/Applications`, starts it at login and registers the `pingme` MCP server for Claude Code, Codex and Cursor, whichever it finds. It never replaces an MCP server named `pingme` that points somewhere else, and it changes nothing else.

`./mac/install.sh --with-session-hook` also adds a Claude Code Stop hook: the island pings you when a finished session waits on you, and your reply goes back into that session. It edits `~/.claude/settings.json` and leaves a backup next to it.

Or let your agent do it. Paste this into Claude Code, Codex or Cursor:

```
Install pingme from https://github.com/kroufekd/pingme and connect it to my account.
```

It follows [AGENTS.md](AGENTS.md). Pairing still needs you: an agent never types or confirms the code.

## For agents

Local MCP server `pingme`, served by the Mac app. Encryption happens on your Mac before anything leaves it.

| Tool | What it does |
|---|---|
| `contacts` | Your contacts and whether they have a Mac online |
| `ping(to, text, urgency, forAgent?)` | Sends one ping, at most 200 characters |
| `status(id)` | Queued, on their Mac, shown, seen, replied, done or snoozed |
| `reply(id)` | The reply, once there is one |

Incoming text from other people reaches agents as quoted data, never as instructions.

## Run your own

Everything runs on a free [Convex](https://convex.dev) project. An idle Mac makes about two backend calls every 5 minutes, so the free plan (1M calls a month) fits a few dozen active people.

1. **Backend.** `cd web && npm install && npx convex dev --once --configure new`, then `npx convex deploy`.
2. **Environment** on the production deployment (`npx convex env set --prod NAME value`):
   - `JWT_PRIVATE_KEY`, `JWKS`: Convex Auth signing keys (see the [Convex Auth setup](https://labs.convex.dev/auth/setup/manual)).
   - `SITE_URL`, `WEB_URL`: where the web app runs, for example `https://pingme.example.com`.
   - `OWNER_EMAIL`: your email. The owner can always sign in, so the network can start from nobody.
   - Sign-in codes go out through `convex/ResendOTP.ts`. Point it at your mail provider.
3. **Web.** `VITE_PINGME_CONVEX_URL=https://<your-deployment>.convex.cloud npm run build` and host the output.
4. **Owner.** Sign in once, then `npx convex run --prod migrations:migrateToNetwork '{"ownerName":"You"}'` makes you the first member.
5. **Mac.** Point the app at your deployment when you install it:

   ```sh
   WEB_URL=https://pingme.example.com \
   API_URL=https://<your-deployment>.convex.site \
   CONVEX_URL=https://<your-deployment>.convex.cloud \
   ./mac/install.sh
   ```

## Limits

| What | Limit |
|---|---|
| Ping and reply text | 200 characters |
| Pings | 30 an hour from one person to another |
| Devices | 10 Macs and 10 browsers per person |
| Pings on the server | Deleted after 7 days |
| Invite links | 7 days, 20 open per person |

## Development

```sh
cd web && npx tsc --noEmit -p . && npx vitest run
cd mac && swift build -c release && .build/release/Pingme --selftest-crypto && .build/release/Pingme --selftest-network && .build/release/Pingme --selftest-mcp
```

The web and the Mac share HPKE test vectors in `shared/hpke-vectors.json`, so both sides prove they seal and open the same bytes.

| Folder | What |
|---|---|
| `web/` | Web app (React, TanStack) and the Convex backend |
| `mac/` | Mac app (Swift, SwiftUI) and installer |
| `shared/` | Test vectors used by both |
| `docs/` | Protocol and API |

## License

MIT, see [LICENSE](LICENSE).
