// HTTP client for the network's device API (/device/*, docs/device-api.md) and its wire types.
// Used by the app and by `Pingme mcp`. The device token goes only into the Authorization header:
// never into a log, a print or an error message.

import Foundation

// MARK: - Wire types (decoded leniently: one odd field must not drop a whole list)

struct SealedBox: Codable, Equatable {
    var enc: String
    var ct: String
    var sealed: Seal.Sealed { Seal.Sealed(enc: enc, ct: ct) }
}

/// A device as contact lists return it. `name`, `createdAt` and `lastSeen` only for your own devices.
struct DeviceInfo: Codable, Equatable {
    var deviceId: String
    var kind: String
    var publicKey: String
    var name: String?
    var lastSeen: Double?

    var isMac: Bool { kind == "mac" }
}

struct Contact: Decodable, Equatable {
    var userId: String
    var name: String
    var hasMac: Bool
    var online: Bool
    var macLastSeen: Double?
    var devices: [DeviceInfo]

    private enum K: String, CodingKey { case userId, name, hasMac, online, macLastSeen, devices }

    init(userId: String, name: String, hasMac: Bool, online: Bool, macLastSeen: Double?, devices: [DeviceInfo]) {
        self.userId = userId
        self.name = name
        self.hasMac = hasMac
        self.online = online
        self.macLastSeen = macLastSeen
        self.devices = devices
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        userId = try c.decode(String.self, forKey: .userId)
        name = (try? c.decode(String.self, forKey: .name)) ?? "?"
        hasMac = (try? c.decode(Bool.self, forKey: .hasMac)) ?? false
        online = (try? c.decode(Bool.self, forKey: .online)) ?? false
        macLastSeen = try? c.decodeIfPresent(Double.self, forKey: .macLastSeen)
        devices = ((try? c.decodeIfPresent([Lossy<DeviceInfo>].self, forKey: .devices)) ?? []).compactMap(\.value)
    }
}

struct Me: Decodable, Equatable {
    var userId: String
    var name: String
    var devices: [DeviceInfo]

    private enum K: String, CodingKey { case userId, name, devices }

    init(userId: String, name: String, devices: [DeviceInfo]) {
        self.userId = userId
        self.name = name
        self.devices = devices
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        userId = try c.decode(String.self, forKey: .userId)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        devices = ((try? c.decodeIfPresent([Lossy<DeviceInfo>].self, forKey: .devices)) ?? []).compactMap(\.value)
    }
}

/// GET /device/contacts.
struct ContactsReply: Decodable, Equatable {
    var now: Double
    var me: Me
    var contacts: [Contact]

    private enum K: String, CodingKey { case now, me, contacts }

    init(now: Double, me: Me, contacts: [Contact]) {
        self.now = now
        self.me = me
        self.contacts = contacts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        now = (try? c.decode(Double.self, forKey: .now)) ?? Date().ms
        me = try c.decode(Me.self, forKey: .me)
        contacts = ((try? c.decodeIfPresent([Lossy<Contact>].self, forKey: .contacts)) ?? []).compactMap(\.value)
    }

    /// Who the ping's sender is, for sealing a reply: yourself or a contact.
    func devices(of userId: String) -> [DeviceInfo]? {
        if userId == me.userId { return me.devices }
        return contacts.first { $0.userId == userId }?.devices
    }
}

/// A ping for this Mac (/device/sync and the devices:feed subscription).
struct InboxItem: Decodable, Equatable {
    var ref: String
    var fromUserId: String?
    var fromName: String
    var fromAgent: String?
    var toUserId: String
    var forAgent: Bool
    var urgency: String
    var dueAt: Double
    var `repeat`: String?
    var createdAt: Double
    var envelope: SealedBox?
    var text: String?
    var unencrypted: Bool

    private enum K: String, CodingKey {
        case ref, fromUserId, fromName, fromAgent, toUserId, forAgent, urgency, dueAt, `repeat`, createdAt, envelope, text,
             unencrypted
    }

    init(ref: String, fromUserId: String?, fromName: String, fromAgent: String?, toUserId: String, forAgent: Bool,
         urgency: String, dueAt: Double, repeat rule: String?, createdAt: Double, envelope: SealedBox?, text: String?,
         unencrypted: Bool) {
        self.ref = ref
        self.fromUserId = fromUserId
        self.fromName = fromName
        self.fromAgent = fromAgent
        self.toUserId = toUserId
        self.forAgent = forAgent
        self.urgency = urgency
        self.dueAt = dueAt
        self.repeat = rule
        self.createdAt = createdAt
        self.envelope = envelope
        self.text = text
        self.unencrypted = unencrypted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        ref = try c.decode(String.self, forKey: .ref)
        fromUserId = try? c.decodeIfPresent(String.self, forKey: .fromUserId)
        fromName = (try? c.decodeIfPresent(String.self, forKey: .fromName)) ?? "?"
        fromAgent = try? c.decodeIfPresent(String.self, forKey: .fromAgent)
        toUserId = (try? c.decodeIfPresent(String.self, forKey: .toUserId)) ?? ""
        forAgent = (try? c.decodeIfPresent(Bool.self, forKey: .forAgent)) ?? false
        urgency = (try? c.decodeIfPresent(String.self, forKey: .urgency)) ?? "green"
        createdAt = (try? c.decodeIfPresent(Double.self, forKey: .createdAt)) ?? Date().ms
        dueAt = (try? c.decodeIfPresent(Double.self, forKey: .dueAt)) ?? createdAt
        `repeat` = try? c.decodeIfPresent(String.self, forKey: .repeat)
        envelope = try? c.decodeIfPresent(SealedBox.self, forKey: .envelope)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        unencrypted = (try? c.decodeIfPresent(Bool.self, forKey: .unencrypted)) ?? false
    }
}

/// A ping you sent (/device/sent), with this Mac's copies of the title and the reply.
struct SentRow: Decodable, Equatable {
    var ref: String
    var fromUserId: String
    var toUserId: String
    var toName: String
    var fromAgent: String?
    var forAgent: Bool
    var urgency: String
    var dueAt: Double
    var createdAt: Double
    var status: String
    var statusAt: Double
    var snoozedUntil: Double?
    var typingUntil: Double?
    var title: SealedBox?
    var reply: SealedBox?
    var replyAt: Double?

    private enum K: String, CodingKey {
        case ref, fromUserId, toUserId, toName, fromAgent, forAgent, urgency, dueAt, createdAt, status, statusAt,
             snoozedUntil, typingUntil, title, reply, replyAt
    }

    init(ref: String, fromUserId: String, toUserId: String, toName: String, status: String, statusAt: Double,
         title: SealedBox? = nil, reply: SealedBox? = nil, replyAt: Double? = nil, snoozedUntil: Double? = nil,
         typingUntil: Double? = nil) {
        self.ref = ref
        self.fromUserId = fromUserId
        self.toUserId = toUserId
        self.toName = toName
        fromAgent = nil
        forAgent = false
        urgency = "green"
        dueAt = statusAt
        createdAt = statusAt
        self.status = status
        self.statusAt = statusAt
        self.snoozedUntil = snoozedUntil
        self.typingUntil = typingUntil
        self.title = title
        self.reply = reply
        self.replyAt = replyAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        ref = try c.decode(String.self, forKey: .ref)
        fromUserId = (try? c.decode(String.self, forKey: .fromUserId)) ?? ""
        toUserId = (try? c.decode(String.self, forKey: .toUserId)) ?? ""
        toName = (try? c.decode(String.self, forKey: .toName)) ?? "?"
        fromAgent = try? c.decodeIfPresent(String.self, forKey: .fromAgent)
        forAgent = (try? c.decode(Bool.self, forKey: .forAgent)) ?? false
        urgency = (try? c.decode(String.self, forKey: .urgency)) ?? "green"
        dueAt = (try? c.decode(Double.self, forKey: .dueAt)) ?? 0
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        status = (try? c.decode(String.self, forKey: .status)) ?? "queued"
        statusAt = (try? c.decode(Double.self, forKey: .statusAt)) ?? 0
        snoozedUntil = try? c.decodeIfPresent(Double.self, forKey: .snoozedUntil)
        typingUntil = try? c.decodeIfPresent(Double.self, forKey: .typingUntil)
        title = try? c.decodeIfPresent(SealedBox.self, forKey: .title)
        reply = try? c.decodeIfPresent(SealedBox.self, forKey: .reply)
        replyAt = try? c.decodeIfPresent(Double.self, forKey: .replyAt)
    }
}

struct Invite: Decodable, Equatable, Identifiable {
    var inviteId: String
    var name: String
    var email: String?
    var expiresAt: Double?
    var id: String { inviteId }
}

struct InviteCreated: Decodable { var inviteId: String; var url: String; var expiresAt: Double? }

/// POST /device/pair/claim, approved.
/// The token is sealed to the pairing key (Net.openPairToken).
struct PairClaimed: Decodable { var sealedToken: Seal.Sealed; var deviceId: String; var userId: String; var name: String? }

private struct SyncReplyWire: Decodable {
    var now: Double?
    var messages: [Lossy<InboxItem>]?
}

private struct InvitesWire: Decodable { var invites: [Lossy<Invite>]? }
private struct SentWire: Decodable { var now: Double?; var rows: [Lossy<SentRow>]? }
private struct DevicesWire: Decodable { var devices: [Lossy<DeviceInfo>]?; var myDevices: [Lossy<DeviceInfo>]? }

// MARK: - Errors

enum ApiError: Error, Equatable {
    case offline
    case unauthorized
    /// HTTP status and the error code from the body, when there is one.
    case server(Int, String?)

    var code: String? { if case .server(_, let c) = self { return c } else { return nil } }

    /// English, for the island.
    var message: String {
        switch self {
        case .offline: return "No internet, try again."
        case .unauthorized: return "This Mac is no longer connected."
        case .server(429, _): return "Too many tries, wait a moment."
        case .server(let s, _): return "The server returned error \(s)."
        }
    }
}

/// What a device call answered: the status, the raw body and the error code (if any).
struct ApiReply {
    var status: Int
    var data: Data

    var error: String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
    }

    func decode<T: Decodable>(_ type: T.Type) -> T? { try? JSONDecoder().decode(T.self, from: data) }

    /// Devices listed in a `stale-devices` answer.
    var staleDevices: (devices: [DeviceInfo], mine: [DeviceInfo]) {
        let w = decode(DevicesWire.self)
        return ((w?.devices ?? []).compactMap(\.value), (w?.myDevices ?? []).compactMap(\.value))
    }

    /// Only the server's own "unauthorized" answer means the token is gone. A bare 401 (a proxy, a
    /// captive portal) must never make the app throw its key away.
    var failure: ApiError {
        status == 401 && error == "unauthorized" ? .unauthorized : .server(status, error)
    }
}

// MARK: - Client

final class DeviceAPI: @unchecked Sendable {
    let base: String
    private let session: URLSession

    init(base: String) {
        self.base = base.hasSuffix("/") ? String(base.dropLast()) : base
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    /// One call. Throws only when there is no answer at all (offline, timeout).
    func call(_ method: String, _ path: String, token: String?, body: [String: Any]? = nil) async throws -> ApiReply {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token { req.setValue("Device \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: req)
        return ApiReply(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
    }

    /// Same, with the "no answer" case folded into ApiError.offline and non-2xx into the failure.
    func result(_ method: String, _ path: String, token: String?, body: [String: Any]? = nil) async -> Result<ApiReply, ApiError> {
        do {
            let r = try await call(method, path, token: token, body: body)
            return (200..<300).contains(r.status) ? .success(r) : .failure(r.failure)
        } catch {
            return .failure(.offline)
        }
    }

    // MARK: Pairing (no token yet)

    func pairStart(pairId: String, secretHash: String, publicKey: String, name: String) async -> Result<Void, ApiError> {
        let body = ["pairId": pairId, "secretHash": secretHash, "publicKey": publicKey, "name": name]
        return await result("POST", "/device/pair/start", token: nil, body: body).map { _ in () }
    }

    enum Claim { case pending, approved(PairClaimed), gone }

    func pairClaim(pairId: String, secret: String) async -> Result<Claim, ApiError> {
        switch await result("POST", "/device/pair/claim", token: nil, body: ["pairId": pairId, "secret": secret]) {
        case .success(let r):
            if r.status == 202 { return .success(.pending) }
            guard let c = r.decode(PairClaimed.self) else { return .failure(.server(r.status, "bad-reply")) }
            return .success(.approved(c))
        case .failure(.server(404, _)):
            return .success(.gone)
        case .failure(let e):
            return .failure(e)
        }
    }

    // MARK: The device

    func sync(token: String, ack: [String], statuses: [[String: Any]], typing: String?) async
        -> Result<(now: Double?, messages: [InboxItem]), ApiError> {
        var body: [String: Any] = [:]
        if !ack.isEmpty { body["ack"] = Array(ack.prefix(100)) }
        if !statuses.isEmpty { body["statuses"] = Array(statuses.prefix(100)) }
        if let typing { body["typing"] = typing }
        return await result("POST", "/device/sync", token: token, body: body).flatMap { r in
            guard let w = r.decode(SyncReplyWire.self) else { return .failure(.server(r.status, "bad-reply")) }
            return .success((w.now, (w.messages ?? []).compactMap(\.value)))
        }
    }

    /// Raw answer, so the caller can reseal on `stale-devices`.
    func reply(token: String, ref: String, at: Double, envelopes: [Seal.Envelope]?, text: String?) async throws -> ApiReply {
        var body: [String: Any] = ["ref": ref, "at": at]
        if let envelopes { body["envelopes"] = envelopes.map { ["deviceId": $0.deviceId, "enc": $0.enc, "ct": $0.ct] } }
        if let text { body["text"] = text }
        return try await call("POST", "/device/reply", token: token, body: body)
    }

    func contacts(token: String) async -> Result<ContactsReply, ApiError> {
        await result("GET", "/device/contacts", token: token).flatMap { r in
            r.decode(ContactsReply.self).map { .success($0) } ?? .failure(.server(r.status, "bad-reply"))
        }
    }

    struct Ping {
        var ref: String
        var to: String
        var forAgent: Bool
        var urgency: String
        var fromAgent: String?
        var envelopes: [Seal.Envelope]
        var titleEnvelopes: [Seal.Envelope]
    }

    /// Raw answer, so the caller can reseal on `stale-devices`.
    func send(token: String, _ p: Ping) async throws -> ApiReply {
        func list(_ e: [Seal.Envelope]) -> [[String: String]] { e.map { ["deviceId": $0.deviceId, "enc": $0.enc, "ct": $0.ct] } }
        var body: [String: Any] = ["ref": p.ref, "to": p.to, "forAgent": p.forAgent, "urgency": p.urgency,
                                   "envelopes": list(p.envelopes), "titleEnvelopes": list(p.titleEnvelopes)]
        if let a = p.fromAgent { body["fromAgent"] = a }
        return try await call("POST", "/device/send", token: token, body: body)
    }

    func sent(token: String, refs: [String]?) async -> Result<(now: Double?, rows: [SentRow]), ApiError> {
        await result("POST", "/device/sent", token: token, body: refs.map { ["refs": $0] } ?? [:]).flatMap { r in
            guard let w = r.decode(SentWire.self) else { return .failure(.server(r.status, "bad-reply")) }
            return .success((w.now, (w.rows ?? []).compactMap(\.value)))
        }
    }

    func invites(token: String) async -> Result<[Invite], ApiError> {
        await result("GET", "/device/invites", token: token).map { r in
            (r.decode(InvitesWire.self)?.invites ?? []).compactMap(\.value)
        }
    }

    func createInvite(token: String, name: String) async -> Result<InviteCreated, ApiError> {
        await result("POST", "/device/invites", token: token, body: ["name": name]).flatMap { r in
            r.decode(InviteCreated.self).map { .success($0) } ?? .failure(.server(r.status, "bad-reply"))
        }
    }

    /// Ends a contact both ways (POST /device/contacts/remove).
    func removeContact(token: String, userId: String) async -> Result<Void, ApiError> {
        await result("POST", "/device/contacts/remove", token: token, body: ["userId": userId]).map { _ in () }
    }

    func revokeInvite(token: String, inviteId: String) async -> Result<Void, ApiError> {
        await result("POST", "/device/invites/revoke", token: token, body: ["inviteId": inviteId]).map { _ in () }
    }

    func unpair(token: String) async -> Result<Void, ApiError> {
        await result("POST", "/device/unpair", token: token).map { _ in () }
    }
}
