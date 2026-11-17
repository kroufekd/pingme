// The network's rules in one place, as pure functions: opening pings, sealing pings and replies,
// key fingerprints, pairing secrets and agent names. The app and `Pingme mcp` both use these,
// and `--selftest-network` checks them offline.

import CryptoKit
import Foundation

/// A ping for this Mac, opened. `unreadable`: its text could not be decrypted (wrong key, tampered
/// or sealed for another device); the title is then a neutral placeholder.
struct IncomingPing: Equatable {
    var ref: String
    var title: String
    var unreadable: Bool
    var fromUserId: String?
    var toUserId: String
    var fromName: String
    var fromAgent: String?
    var forAgent: Bool
    var urgency: String
    var dueAt: Double
    var `repeat`: String?
    var createdAt: Double
    /// Legacy remote MCP (`Net.isLegacy`): plaintext both ways, marked on the island.
    var plain: Bool
}

enum Net {
    static let unreadableTitle = "Zprávu na tomhle Macu nejde přečíst."
    /// Same cap as the web: 200 UTF-16 units, so at most 600 bytes of UTF-8 (the server takes 800).
    static let textMax = 200

    // MARK: Text

    /// Trimmed and cut to `textMax` UTF-16 units on a character boundary. Empty stays empty.
    static func cap(_ text: String) -> String {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.utf16.count > textMax { s.removeLast() }
        return s
    }

    // MARK: Opening

    /// The only plaintext the Mac accepts: the shape the legacy remote /mcp writes (no user sender,
    /// agent "mcp", never for the agent). Anything else flagged unencrypted is a downgrade attempt by
    /// the server and gets the placeholder. Delete together with /mcp.
    static func isLegacy(_ item: InboxItem) -> Bool {
        item.unencrypted && item.fromUserId == nil && item.fromAgent == "mcp" && !item.forAgent
    }

    /// Decrypts one inbox item with this Mac's key. Never throws: anything that does not open becomes a placeholder.
    static func open(_ item: InboxItem, key: Seal.PrivateKey?) -> IncomingPing {
        var title = unreadableTitle
        var unreadable = true
        let legacy = isLegacy(item)
        if item.unencrypted {
            if legacy {
                let t = cap(item.text ?? "")
                if !t.isEmpty { title = t; unreadable = false }
            }
        } else if let key, let env = item.envelope, let from = item.fromUserId,
                  let aad = try? Seal.aad(kind: .title, ref: item.ref, from: from, to: item.toUserId),
                  let text = try? Seal.open(privateKey: key, env.sealed, aad: aad) {
            let t = cap(text)
            if !t.isEmpty { title = t; unreadable = false }
        }
        return IncomingPing(
            ref: item.ref, title: title, unreadable: unreadable, fromUserId: item.fromUserId, toUserId: item.toUserId,
            fromName: String(item.fromName.prefix(kNameMax)), fromAgent: item.fromAgent.map { String($0.prefix(40)) },
            forAgent: item.forAgent, urgency: Urgency(rawValue: item.urgency)?.rawValue ?? "green", dueAt: item.dueAt,
            repeat: Recurrence.valid(item.repeat), createdAt: item.createdAt, plain: legacy)
    }

    /// A reply goes out as plaintext only for a legacy ping, which never has a user sender. Also guards
    /// events saved before the shape check, when a forged ping could be stored as plain.
    static func sendsPlain(_ e: StatusEvent) -> Bool { e.plain == true && e.from == nil }

    /// Shown next to the sender of a legacy plaintext ping, so a forged one cannot pass as encrypted.
    static let plainMarker = "nešifrované"

    /// Opens a sealed copy from a sent row (title or reply). Nil when it is not there or does not open.
    static func open(_ box: SealedBox?, kind: Seal.Kind, row: SentRow, key: Seal.PrivateKey) -> String? {
        guard let box, let aad = try? Seal.aad(kind: kind, ref: row.ref, from: row.fromUserId, to: row.toUserId) else {
            return nil
        }
        return try? Seal.open(privateKey: key, box.sealed, aad: aad)
    }

    // MARK: Sealing

    /// A reply goes to every active device of the ping's sender, web and Mac. The AAD keeps the ping's
    /// sender and recipient as they are: a reply never swaps them.
    static func sealReply(_ text: String, ref: String, pingFrom: String, pingTo: String,
                          devices: [DeviceInfo]) throws -> [Seal.Envelope] {
        let aad = try Seal.aad(kind: .reply, ref: ref, from: pingFrom, to: pingTo)
        return try Seal.sealEnvelopes(devices.map { ($0.deviceId, $0.publicKey) }, plaintext: text, aad: aad)
    }

    /// A ping: one copy for each of the recipient's Macs (the server wants exactly those) and one for
    /// each of your own devices, so they can show what you sent.
    static func sealPing(_ text: String, ref: String, from: String, to: String, recipient: [DeviceInfo],
                         mine: [DeviceInfo]) throws -> (envelopes: [Seal.Envelope], titleEnvelopes: [Seal.Envelope]) {
        let aad = try Seal.aad(kind: .title, ref: ref, from: from, to: to)
        let macs = recipient.filter(\.isMac).map { ($0.deviceId, $0.publicKey) }
        let own = mine.map { ($0.deviceId, $0.publicKey) }
        return (try Seal.sealEnvelopes(macs, plaintext: text, aad: aad), try Seal.sealEnvelopes(own, plaintext: text, aad: aad))
    }

    // MARK: Reply outcome

    enum Outcome: Equatable { case delivered, drop, retryLater, reseal, unauthorized }

    /// What to do with a queued reply after the server answered. Anything that can never succeed
    /// is dropped, so the outbox cannot loop forever.
    static func outcome(status: Int, error: String?) -> Outcome {
        switch status {
        case 200..<300: return .delivered
        case 401 where error == "unauthorized": return .unauthorized
        case 401: return .retryLater
        case 409 where error == "stale-devices": return .reseal
        case 429, 500...599, 0: return .retryLater
        default: return .drop
        }
    }

    // MARK: Fingerprint

    /// Safety number of one device key: SHA-256 of the raw 32-byte public key, the first 15 bytes as
    /// three 40-bit big-endian numbers, each mod 100000, zero-padded to 5 digits, joined by spaces.
    static func fingerprint(_ publicKey: String) -> String? {
        guard let raw = Data(base64Encoded: publicKey), raw.count == 32 else { return nil }
        let h = Array(SHA256.hash(data: raw))
        return (0..<3).map { g -> String in
            let n = h[(g * 5)..<(g * 5 + 5)].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            return String(format: "%05llu", n % 100_000)
        }.joined(separator: " ")
    }

    // MARK: Pairing

    /// Random bytes, base64url without padding.
    static func randomB64url(_ count: Int) -> String {
        let bytes = SymmetricKey(size: SymmetricKeySize(bitCount: count * 8)).withUnsafeBytes { Data($0) }
        return b64url(bytes)
    }

    static func b64url(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Lowercase hex SHA-256 of the UTF-8 of the secret string as written in the URL.
    static func secretHash(_ secret: String) -> String {
        SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static let pairInfo = "pingme pair v1"

    /// The 6 digits the island shows and the owner types on /pair, so a pairing link sent by someone
    /// else cannot be approved: SHA-256 of "pairId|publicKey", first 4 bytes big-endian, mod 1 000 000.
    /// Same as pairCode() in web/convex/network.ts.
    static func pairCode(pairId: String, publicKey: String) -> String {
        let h = Array(SHA256.hash(data: Data("\(pairId)|\(publicKey)".utf8)))
        let n = h[0..<4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        return String(format: "%06u", n % 1_000_000)
    }

    /// The claim returns the device token sealed to this pairing's key, so whoever else holds the
    /// pairing link gets nothing usable.
    static func openPairToken(_ sealed: Seal.Sealed, privateKey: Seal.PrivateKey, pairId: String,
                              userId: String) throws -> String {
        for f in [pairId, userId] where f.isEmpty || f.contains("|") { throw Seal.Failure.badField(f) }
        return try Seal.open(privateKey: privateKey, sealed, aad: Data("\(pairInfo)|\(pairId)|\(userId)".utf8),
                             info: Data(pairInfo.utf8))
    }

    /// The fragment never reaches the server.
    static func pairURL(web: String, pairId: String, secret: String) -> URL? {
        let base = web.hasSuffix("/") ? String(web.dropLast()) : web
        return URL(string: "\(base)/pair#\(pairId).\(secret)")
    }

    // MARK: Agents

    /// The sending agent's name as people see it on the island, from MCP clientInfo.name. 1 to 40 characters.
    static func agentName(_ client: String?) -> String {
        let raw = (client ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let low = raw.lowercased()
        if low.contains("claude") { return "Claude Code" }
        if low.contains("codex") || low.contains("openai") { return "Codex" }
        if low.contains("cursor") { return "Cursor" }
        let clean = raw.filter { !$0.isNewline && $0 != "|" }
        return clean.isEmpty ? "Agent" : String(clean.prefix(40))
    }
}
