# pingme network API

Everything the Mac app and the web need to talk to the backend in phase 2. The server relays
ciphertext only: it knows who sends to whom, when and how urgent, never the text of a ping or a
reply. Source of truth for every shape here: `web/convex/` (tests in `web/convex/network.test.ts`
call exactly these shapes).

- Web: Convex functions through the Convex client (`useQuery`, `useMutation`, `useAction`), signed
  in with Convex Auth.
- Mac: HTTP on the Convex site URL (`https://<deployment>.convex.site`) under `/device/*`, plus one
  Convex subscription (`devices:feed`) for instant delivery.

## Conventions

- Times are milliseconds since the Unix epoch, server clock. HTTP answers that matter carry `now`.
- Ids (`userId`, `deviceId`, `inviteId`) are opaque Convex id strings. Compare them as strings.
- HTTP: request and response bodies are JSON (`Content-Type: application/json`), at most 64 KB.
  Success is HTTP 200 with `{ "ok": true, ... }` (one exception: pairing still pending is 202).
  Failure is `{ "ok": false, "error": "<code>", ...details }` with the HTTP status from
  [Errors](#errors).
- Convex functions return the same objects; a nullable field is `null`, never missing, unless the
  shape below marks it optional with `?`.

### Encodings

| Value | Format |
|---|---|
| `publicKey`, `enc` | raw 32 bytes, standard base64 with padding (44 chars, ends with `=`) |
| `ct` | standard base64 with padding, 24 to 1088 chars (17 to 816 bytes: plaintext 1 to 800 bytes plus the 16 byte tag) |
| `ref` | 16 random bytes, base64url without padding (22 chars), made by the sender. Legacy refs (remote MCP, see below) are Convex ids; device endpoints accept `^[A-Za-z0-9_-]{16,64}$` |
| device token | 32 random bytes, base64url without padding (43 chars), made by the server |
| `pairId` | 16 random bytes, base64url without padding (22 chars), made by the Mac |
| `secret` | 32 random bytes, base64url without padding (43 chars), made by the Mac |
| `secretHash` | lowercase hex SHA-256 of the UTF-8 bytes of the `secret` string (the 43 characters as written in the URL, not the decoded bytes) |
| pairing `code` | 6 decimal digits, see [Pairing code](#pairing-code) |

Clients cap ping text and reply text at 200 characters before sealing. The plaintext is the
UTF-8 text itself, no JSON around it.

## Crypto

- HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305.
- `info` = UTF-8 of `pingme v1`.
- One envelope per target device: `{ "deviceId": string, "enc": string, "ct": string }`, sealed to
  that device's `publicKey`.
- AAD = UTF-8 of `"pingme v1|" + kind + "|" + ref + "|" + fromUserId + "|" + toUserId`,
  `kind` is `title` or `reply`.
- **`fromUserId` and `toUserId` are always the ping's sender and recipient, for both kinds. A reply
  does not swap them.** Every payload that carries an envelope also carries `ref`, `fromUserId`
  and `toUserId`, so the reader rebuilds the AAD from the same object.
- Web: `web/src/lib/seal.ts` (`generateKeyPair`, `seal`, `open`, `aadFor`). Mac: `mac/Sources/Seal.swift`.
  Shared vectors: `shared/hpke-vectors.json`.

Example. Viki (`userId` `V`) pings Dominik (`userId` `D`) with ref `R`:

```
title, sealed by Viki to each of Dominik's Macs and to each of her own devices:
  pingme v1|title|R|V|D
reply, sealed by Dominik's Mac to each of Viki's devices:
  pingme v1|reply|R|V|D
```

### Pairing token

`POST /device/pair/claim` never returns the device token in plaintext. It returns
`sealedToken: { enc, ct }`, HPKE sealed (same suite) to the `publicKey` the Mac sent in
`/device/pair/start`:

- `info` = UTF-8 of `pingme pair v1` (not `pingme v1`, so it can never open as a ping or reply);
- AAD = UTF-8 of `"pingme pair v1|" + pairId + "|" + userId` (`userId` from the same answer);
- plaintext = the 43 character token string, UTF-8.

Web: `sealWithInfo`, `openWithInfo`, `PAIR_INFO`, `pairTokenAad` in `web/src/lib/seal.ts`. Mac:
`Seal.open(privateKey:_:aad:info:)`.

Which devices to seal to:

| Ciphertext | Targets | Rule on the server |
|---|---|---|
| ping (`envelopes`) | every active Mac of the recipient | exactly that set, else `stale-devices` |
| sender's copy (`titleEnvelopes`) | your own active devices, web and Mac | each must be one of yours (any subset, also none); seal to all of them, or your other devices show no title |
| reply (`envelopes` on `/device/reply`) | every active device of the ping's sender, web and Mac | at least one must be active; envelopes for gone devices are dropped |

Device lists come from `contacts.list` (web) or `GET /device/contacts` (Mac). On `stale-devices`
the error carries the current lists, so the client seals again and retries once.

## Who is a member

A member is a signed-in account that claimed an invite link (or was migrated). Only members can do
anything below. Contacts are pairs of members who invited each other (one link makes the contact
both ways). You can ping a contact or yourself (your other Macs), nobody else. A person without a
Mac can send and read replies but cannot be pinged (`hasMac: false`).

## Web (Convex functions)

### `senders.me` (query) `{}`

```ts
| { status: "signedOut" }
| { status: "notMember"; email: string }
| { status: "member"; name: string; userId: string; senderId?: string; onboarded: boolean; inviterName?: string }
```

`userId` goes into the AAD. `inviterName` is who invited this person (for the intro).
`senderId` exists only for v2 accounts; ignore it.

### `senders.finishOnboarding` (mutation) `{}` -> `null`

### `devices.registerWeb` (mutation) `{ publicKey: string, name?: string }`

```ts
| { ok: true; deviceId: string }
| { ok: false; error: "not-member" | "bad-key" }
```

Call on every app load with the public key kept in IndexedDB. The same key returns the same
device. At most 10 active web devices per person: a new one revokes the least recently seen one.
A browser that lost its key makes a new pair and registers again.

### `devices.revoke` (mutation) `{ deviceId: string }` -> `boolean`

Revokes one of your own devices (web or Mac). False for anything else. The web lists every device
from `contacts.list` `me.devices` ("Zařízení") with a remove button, and shows "Nový Mac" at the
top while a Mac created after this browser (and less than 7 days ago) is not confirmed there.

### `contacts.list` (query) `{}`

```ts
| { status: "signedOut" }
| { status: "notMember" }
| {
    status: "member"
    me: { userId: string; name: string; devices: MyDevice[] }
    contacts: Contact[] // sorted by name
  }

type MyDevice = { deviceId: string; kind: "mac" | "web"; publicKey: string; name: string; createdAt: number; lastSeen: number }
type Contact = {
  userId: string
  name: string
  hasMac: boolean // false: grey, cannot be pinged
  online: boolean // a Mac checked in during the last 5 minutes, as of this query run
  macLastSeen: number | null
  devices: { deviceId: string; kind: "mac" | "web"; publicKey: string }[] // all active devices
}
```

A Convex query does not rerun just because time passes, so `online` can go stale while nothing
changes. The web shows the dot from `macLastSeen` on its own timer: online when
`Date.now() - macLastSeen < 5 * 60_000`.

### `messages.send` (mutation)

```ts
{
  ref: string            // newRef(), 22 chars
  to: string             // contact userId, or your own userId
  forAgent: boolean      // true: for the recipient's agent (triaged on the Mac); dueAt and repeat are ignored
  urgency: "green" | "orange" | "red"
  dueAt?: number         // default now; now - 1 day ... now + 60 days
  repeat?: "daily" | "weekdays" | "weekly" | "biweekly" | "monthly"
  envelopes: Envelope[]      // kind "title", one per active Mac of the recipient
  titleEnvelopes: Envelope[] // kind "title", your own devices
}
```

```ts
| { ok: true; ref: string }
| { ok: false; error: SendError; devices?: DeviceInfo[]; myDevices?: DeviceInfo[] }

type SendError = "not-member" | "bad-ref" | "bad-urgency" | "bad-repeat" | "bad-time" | "bad-agent"
  | "bad-envelope" | "ref-taken" | "not-contact" | "no-device" | "stale-devices" | "rate-limited"
type DeviceInfo = { deviceId: string; kind: "mac" | "web"; publicKey: string }
```

- `stale-devices` carries `devices` (the recipient's active Macs) and `myDevices` (all your active
  devices). Seal again and retry with the same `ref`.
- Sending the same `ref` to the same person again is a retry: `{ ok: true }`, nothing new is
  stored. The same `ref` with anything else is `ref-taken`.
- `no-device`: the contact has no Mac. `not-contact` also covers unknown or malformed `to`.
- 30 pings per hour per sender and recipient (`rate-limited`).

### `messages.mine` (query) `{ deviceId?: string }`

```ts
| { status: "signedOut" }
| { status: "notMember" }
| { status: "member"; deviceActive: boolean; rows: SentRow[] } // newest first, at most 50

type SentRow = {
  ref: string
  fromUserId: string // you
  toUserId: string
  toName: string
  fromAgent: string | null
  forAgent: boolean
  urgency: "green" | "orange" | "red"
  dueAt: number
  repeat: string | null
  createdAt: number
  status: "queued" | "waiting" | "popped" | "seen" | "replied" | "done" | "snoozed"
  statusAt: number
  snoozedUntil: number | null // only while snoozed
  typingUntil: number | null  // "píše" while typingUntil > now
  title: { enc: string; ct: string } | null // your device's copy, kind "title"
  reply: { enc: string; ct: string } | null // your device's copy, kind "reply"
  replyAt: number | null      // set once a reply exists, even when this device has no copy
}
```

Pass this browser's `deviceId`. Only that device's envelopes come back. `deviceActive: false`
means the device is unknown, someone else's or revoked: call `registerWeb` again. `title: null`
or (`replyAt` set and `reply: null`) means the text was sealed for another device
("Odpověď je na jiném zařízení."). Done rows disappear 24 hours after done; any row 7 days after
its last change.

### `messages.ackReply` (mutation) `{ ref: string, deviceId: string }` -> `boolean`

Drops this device's copy of the reply after showing it. Other devices keep theirs. Optional: keep
the decrypted text locally if you want to show it again.

### Pairing page `/pair#<pairId>.<secret>`

The fragment never reaches the server. The page computes `secretHash` from `secret`, then asks
for the [pairing code](#pairing-code) the Mac shows. A link alone is not enough: someone can
send you a `/pair` link for their own Mac, and approving it would let that Mac read every ping
to you. The page says so in one line: "Nevidíš kód na svém Macu? Nepřipojuj."

`devices.pairing` (query) `{ pairId, secretHash }`

```ts
| { status: "signedOut" }
| { status: "notMember" }
| { status: "invalid" }                                  // unknown, wrong hash, expired, or another account took it
| { status: "pending"; name: string; expiresAt: number } // show "Připojit tento Mac" with the Mac's name
| { status: "approved" }                                 // this account already approved it
```

It never returns the code or the Mac's key: the code must come from the Mac's screen.

`devices.approvePairing` (mutation) `{ pairId, secretHash, code }`

```ts
| { ok: true }   // also when this account approved it before
| { ok: false; error: "not-member" | "invalid" | "bad-code" }
```

- `bad-code`: the code does not match; nothing is approved. The 5th wrong code deletes the
  request and answers `invalid` (the Mac then gets `404` and starts over).
- The request stays until it expires (10 minutes from the start), also after the Mac claimed it;
  then `devices.pairing` answers `invalid`. After `approvePairing` returns `{ ok: true }`, show
  your own "done" state and stop reading the query.

### Invites (any member)

`inviteLinks.create` (**action**) `{ name: string }` (the invited person's name, 1 to 60 chars)

```ts
| { ok: true; inviteId: string; url: string; expiresAt: number } // url: <web>/?i=<token>, works once, 7 days
| { ok: false; error: "not-member" | "bad-name" | "too-many-invites" | "rate-limited" }
```

At most 20 open links per member and 10 new ones per hour. Only the hash of the token is stored:
the `url` is shown once.

`inviteLinks.mine` (query) `{}` -> `null` (not a member) or

```ts
{ inviteId: string; name: string; email: string | null; createdAt: number; expiresAt: number }[] // unused, newest first
```

`inviteLinks.revoke` (mutation) `{ inviteId: string }` -> `boolean`

Joining (same flow as phase 1):

- `inviteLinks.check` (query) `{ token }` -> `{ ok: true; name: string; inviterName?: string } | { ok: false }`
- `inviteLinks.start` (mutation) `{ token, email }` -> `{ ok: true } | { ok: false; error: "bad-link" | "bad-email" }`
- then the email code (Convex Auth), then `inviteLinks.claim` (mutation) `{ token }` ->
  `{ ok: true; name: string } | { ok: false; error: "bad-link" | "wrong-email" | "signed-out" }`.
  Claiming makes the person a member and a contact of the inviter, both ways.
- `invites.check` (query) `{ email }` -> `boolean`. The owner (env `OWNER_EMAIL`) is always allowed.

## Mac: pairing

1. Make `pairId` (16 B), `secret` (32 B) and the device key pair (private key in the Keychain).
2. `POST /device/pair/start` (no auth)

   ```json
   { "pairId": "<22>", "secretHash": "<64 hex>", "publicKey": "<44 b64>", "name": "MacBook Michala" }
   ```

   `name` is the Mac's name, 1 to 60 characters, shown on the pairing page.
   `200 { "ok": true, "expiresAt": 1731850600000 }`. Errors: `400 bad-request`,
   `409 pair-exists`, `429 rate-limited` (10 starts per hour for the whole server). The request
   lives 10 minutes.
3. Show the [pairing code](#pairing-code) on the island while waiting, and open
   `https://pingme.macaly.app/pair#<pairId>.<secret>` in the browser. The signed-in person types
   the code there and approves.
4. Every 2 s: `POST /device/pair/claim` (no auth) `{ "pairId": "...", "secret": "<43>" }`

   - `202 { "ok": true, "status": "pending" }`: keep polling.
   - `200 { "ok": true, "status": "approved", "sealedToken": { "enc": "<44>", "ct": "<80>" }, "deviceId": "...", "userId": "...", "name": "Michal" }`:
     open `sealedToken` with the device private key ([Pairing token](#pairing-token)) and store
     the token in the Keychain. `name` is the account's name. Until the request expires, every
     claim with the secret returns this same answer (one device, one token), so a retry after a
     lost answer is safe and someone else who saw the URL gets nothing they can open. If it does
     not open, treat it as a failed pairing and start over.
   - `429 rate-limited`: more than 60 claims a minute for this request. Keep polling at 2 s.
   - `404 { "ok": false, "error": "not-found" }`: unknown, wrong secret, expired, too many wrong
     codes, or the device was removed in the meantime. Stop and start over. A `404` after the
     page said "Připojeno" is not normal: say the pairing was cancelled and ask the person to
     check "Zařízení" on the web.
   - `400 bad-request`: malformed body.

   At most 10 active Macs per account: a new one revokes the least recently seen one.

### Pairing code

Six digits the Mac shows and the person types on `/pair`. Both sides can compute it; the server
checks it in `approvePairing`.

1. `h` = SHA-256 of the UTF-8 bytes of `pairId + "|" + publicKey` (the 22 character pairId and the
   44 character base64 public key, exactly as sent to `/device/pair/start`).
2. `n` = the first 4 bytes of `h` as a big-endian unsigned 32-bit integer.
3. `code` = `n mod 1000000`, as decimal, zero-padded to 6 digits.

Test vector: `pairId` `AbCdEfGhIjKlMnOpQrStUv`, `publicKey`
`AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` (bytes 0 to 31): `h` starts with `ee9da735`,
`code` = `309365`.

Server: `pairCode` in `web/convex/network.ts`.

The code proves the person approving sees the Mac that asked. It does not stop someone who
starts a pairing on their own Mac and then talks you into typing its code; that is why every
device is listed with a remove button (web "Zařízení", `POST /device/devices/revoke` for the
Mac) and a new Mac is announced on the person's other devices.

## Mac: device API

Every call below needs `Authorization: Device <token>`. A missing, unknown or revoked token is
`401 { "ok": false, "error": "unauthorized" }`. A missing or malformed header is refused before
the body is read; an unknown or revoked token is found inside the call, so a malformed body may
answer 400 first. On 401 the Mac drops the token and shows "Připojit tento Mac".

### `GET /device/me`

```json
{ "ok": true, "deviceId": "...", "userId": "...", "name": "Michal", "deviceName": "MacBook Michala" }
```

### `POST /device/sync`: keep-alive, delivery, statuses, typing

Call every 5 minutes (this is the keep-alive: a Mac counts as online for 12 minutes after it), and
right after the feed shows new messages or the outbox has statuses. Every call is billed, so do not
poll faster; while the live feed is down, poll every 3 s for a minute, then every 30 s.

```json
{
  "ack": ["<ref>", "..."],
  "statuses": [{ "ref": "<ref>", "status": "popped", "at": 1731850000000, "snoozedUntil": 1731853600000 }],
  "typing": "<ref>"
}
```

All fields optional. `ack`: refs stored on this Mac (max 100). `statuses` (max 100) for pings
sent to you: `status` one of `waiting`, `popped`, `seen`, `done`, `snoozed` (`snoozedUntil` only
with `snoozed`); a status older than the stored one is ignored; malformed or foreign items are
skipped, so drop the whole batch from the outbox after a 200. Replies do not go here.
`typing`: the ref you are typing a reply to (shown for 6 s).

```json
{ "ok": true, "now": 1731850000123, "deviceId": "...", "messages": [InboxItem] }
```

```ts
type InboxItem = {
  ref: string
  fromUserId: string | null // null only for legacy remote MCP
  fromName: string
  fromAgent: string | null  // the sending agent's name ("Claude Code"), or "mcp" for legacy remote MCP
  toUserId: string          // you
  forAgent: boolean
  urgency: "green" | "orange" | "red"
  dueAt: number
  repeat: "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | null
  createdAt: number
  expiresAt: number
  envelope: { enc: string; ct: string } | null // yours, kind "title"; null only when unencrypted
  text: string | null                          // plaintext, only when unencrypted
  unencrypted: boolean                         // legacy remote MCP only, never for network pings
}
```

Oldest first, at most 50, only messages not yet acked by this device. A message is deleted once
every active Mac it was sealed to acked it, or after 7 days.

### Convex subscription `devices:feed` `{ token: string }`

```ts
| { ok: false }
| { ok: true; deviceId: string; messages: InboxItem[] }
```

Same `messages` as `/device/sync`, live. It has no clock and does not keep you online: keep
calling `/device/sync`. `{ ok: false }` means the token is no longer valid.

### `POST /device/reply`

```json
{ "ref": "<ref>", "at": 1731850000000, "envelopes": [{ "deviceId": "...", "enc": "...", "ct": "..." }] }
```

Envelopes: kind `reply`, AAD with the ping's `fromUserId` and `toUserId` (not swapped), one per
active device of the ping's sender (from `/device/contacts`, or `me` when you pinged yourself).
For an `unencrypted` (legacy) message send `"text": "..."` (1 to 200 chars) instead of
`envelopes`; never both.

- `200 { "ok": true }`. Sets the status to `replied` (unless a newer status is stored) and
  replaces any earlier reply.
- `404 not-found` (not a ping to you), `400 bad-time | bad-envelope | bad-text | bad-request`.
- `409 { "ok": false, "error": "stale-devices", "devices": [DeviceInfo] }`: none of the envelopes
  is for an active device of the sender. Seal to `devices` and retry.

### `GET /device/contacts`

```json
{
  "ok": true,
  "now": 1731850000123,
  "me": { "userId": "...", "name": "Michal", "devices": [MyDevice] },
  "contacts": [Contact]
}
```

Same `MyDevice` and `Contact` as `contacts.list`; here `online` is computed at `now`.

### `POST /device/send`

```json
{
  "ref": "<22>",
  "to": "<userId>",
  "forAgent": false,
  "urgency": "orange",
  "dueAt": 1731850000000,
  "repeat": null,
  "fromAgent": "Claude Code",
  "envelopes": [Envelope],
  "titleEnvelopes": [Envelope]
}
```

Same rules as `messages.send`. `urgency` defaults to `green`, `forAgent` to `false`, `dueAt` to
now, `titleEnvelopes` to `[]`; `dueAt`, `repeat`, `fromAgent` may be `null` or missing. `fromAgent` (1 to 40 chars) marks a
ping sent by an agent through the local MCP; leave it out when the person sends.

- `200 { "ok": true, "ref": "<ref>" }`
- `409 { "ok": false, "error": "stale-devices", "devices": [DeviceInfo], "myDevices": [DeviceInfo] }`
- other errors as in [Errors](#errors).

### `POST /device/sent`: what you sent, for `status(id)` and `reply(id)`

```json
{ "refs": ["<ref>"] }
```

`refs` optional (max 50). Without it: your newest 50 (done ones only for 24 hours).

```json
{ "ok": true, "now": 1731850000123, "rows": [SentRow] }
```

Same `SentRow` as `messages.mine`, with this Mac's envelopes. Includes pings sent from your other
devices; `title` is `null` when it was not sealed for this Mac.

### `POST /device/invites` `{ "name": "Viki" }`

`200 { "ok": true, "inviteId": "...", "url": "https://pingme.macaly.app/?i=<token>", "expiresAt": 0 }`.
Errors: `400 bad-name`, `429 too-many-invites | rate-limited`.

### `GET /device/invites`

`200 { "ok": true, "invites": [{ "inviteId": "...", "name": "Viki", "email": null, "createdAt": 0, "expiresAt": 0 }] }`

`email` is set once the invited person typed it on the link.

### `POST /device/invites/revoke` `{ "inviteId": "..." }`

`200 { "ok": true }` or `404 not-found` (not yours, used or gone).

### `POST /device/unpair`

`200 { "ok": true }`. Revokes this Mac; its token stops working at once.

### `POST /device/devices/revoke` `{ "deviceId": "..." }`

Removes one of your person's devices (web or Mac, this one included), listed in
`GET /device/contacts` under `me.devices`. `200 { "ok": true }`, `404 not-found` (not yours or
already removed), `400 bad-request`. The Mac should show its person's devices with this, and a
"Nový Mac" notice for a Mac in `me.devices` whose `createdAt` is newer than its own.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | missing, unknown or revoked device token |
| `bad-request` | 400 | malformed JSON or wrong field types |
| `bad-ref`, `bad-urgency`, `bad-repeat`, `bad-time`, `bad-agent`, `bad-envelope`, `bad-text`, `bad-name` | 400 | one field is invalid |
| `not-contact` | 403 | not your contact (or unknown user) |
| `not-member` | 403 | web only: signed in but not a member |
| `bad-code` | - | web only (`approvePairing`): the pairing code does not match |
| `not-found` | 404 | unknown, foreign, used or expired |
| `ref-taken`, `no-device`, `stale-devices`, `pair-exists` | 409 | conflict, see the endpoint |
| `too-large` | 413 | body over 64 KB |
| `rate-limited`, `too-many-invites` | 429 | limit reached |

## Limits

| What | Limit |
|---|---|
| pings | 30 per hour per sender and recipient |
| pairing starts | 10 per hour, whole server |
| pairing request | 10 minutes |
| pairing claims | 60 per minute per request (`429 rate-limited`) |
| pairing code | 5 wrong codes, then the request is deleted |
| invite links | 10 new per hour, 20 open per member, 7 days each |
| active devices | 10 web and 10 Mac per person (least recently seen is revoked) |
| undelivered message | 7 days |
| status row | 7 days after its last change, 24 hours after done |
| envelopes per list | 10 (`envelopes` on send), 20 otherwise |
| `online` | a Mac `/device/sync` within 5 minutes (`lastSeen` is written at most every 30 s) |

## Legacy, kept during the move

- `/mac/*` with `MAC_TOKEN`, `macFeed:get`, the `commands` table and `relay.*`, `tasks.*`,
  `pin.*` keep working unchanged for the installed v2 Mac app and old browser tabs. New people
  (network invites) never get a `senders` row, so they cannot use that plaintext path.
- `/mac/sender-revoke` on a person also takes that person out of the network: membership,
  contacts, devices and open invite links.
- Remote `/mcp` with agent keys: once the owner (env `OWNER_EMAIL`) has an active paired Mac, a
  `pingme` call becomes an `unencrypted: true` message to the owner (`fromUserId: null`,
  `fromName` = the key's name, `fromAgent: "mcp"`, plaintext in `text`). The owner's Mac replies
  with `/device/reply { ref, at, text }`; `get_status` and `get_reply` work as before. Until the
  owner has a paired Mac, it stays on the v2 `commands` queue. Do not extend this path.

## Deploy and migration (main session only)

1. Set env `OWNER_EMAIL` on the deployment (the owner can then always get a code).
2. Deploy. Two new crons: the hourly cleanup (unchanged) and every 10 minutes
   `cleanup:network` (expired messages, pairing requests, rate limit windows).
3. The owner signs in on the web once, then run `migrations:migrateToNetwork {}` (optionally
   `{ "ownerName": "Dominik" }`). It answers
   `{ ok: true, ownerId, members, contacts, invites }` or
   `{ ok: false, error: "no-owner-email" | "owner-not-signed-in" }` without writing. Running it
   again changes nothing.
4. The owner pairs the new Mac app; then `MAC_TOKEN` can go.
