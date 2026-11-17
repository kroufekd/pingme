// Connection to the server: the live feed (Convex subscription), /mac/sync and the people routes.
// The token never goes into a log, a print or an error message.

import AppKit
import Combine
import ConvexMobile
import CryptoKit
import Foundation
import Security

// MARK: - HTTP

enum ApiError: Error {
    case offline, unauthorized, conflict, status(Int)

    var message: String {
        switch self {
        case .offline: return "Bez internetu, zkus to znovu."
        case .unauthorized: return "pingme nemá platný klíč k webu."
        case .conflict: return "Klíč už existuje, zkus to znovu."
        case .status(let s): return "Server vrátil chybu \(s)."
        }
    }
}

struct InviteLink: Decodable { var senderId: String?; var url: String; var expiresAt: Double? }
private struct SendersReply: Decodable { var senders: [Lossy<Sender>] }

@MainActor
final class SyncEngine {
    private let store: TaskStore
    private let config: AppConfig
    private let session: URLSession
    private var inFlight = false
    private var again = false
    private(set) var lastAttempt = Date.distantPast
    private(set) var lastFailed = false
    /// Server clock from the last /mac/sync, to judge `webLastSeen` from the feed.
    private var serverNow: Double?
    private var serverNowAt = Date()
    /// What the server said about the web in the last /mac/sync.
    private var replyWatching = false
    /// From the live feed. Nil when the feed has not delivered or the web never pinged.
    var feedWebLastSeen: Double?
    /// True while the live feed is delivering. Then the Mac judges "watching" itself.
    var feedHealthy: () -> Bool = { false }
    /// Commands the server confirmed deleting, so a late feed value does not trigger another sync.
    private var confirmedAt: [String: Date] = [:]
    var onSynced: (() -> Void)?

    init(store: TaskStore, config: AppConfig) {
        self.store = store
        self.config = config
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    /// Someone has the web open: the snapshot goes with every sync.
    var watching: Bool {
        guard feedHealthy() else { return replyWatching }
        guard let seen = feedWebLastSeen else { return false }
        return serverClock() - seen < 60_000
    }

    private func serverClock() -> Double {
        guard let n = serverNow else { return Date().ms }
        return n + Date().timeIntervalSince(serverNowAt) * 1000
    }

    func recentlyConfirmed(_ id: String) -> Bool {
        guard let at = confirmedAt[id] else { return false }
        return Date().timeIntervalSince(at) < 30
    }

    /// Sync right away when there is something to send (a status, or the snapshot while watched).
    func noteLocalChange() {
        if !store.outbox.isEmpty || watching { syncNow() }
    }

    func syncNow() { Task { await self.sync() } }

    func sync() async {
        if inFlight { again = true; return }
        inFlight = true
        var rounds = 0
        repeat {
            again = false
            rounds += 1
            lastAttempt = Date()
            await roundTrip()
        } while again && rounds < 4
        inFlight = false
        onSynced?()
    }

    private func roundTrip() async {
        let acks = store.acks
        let statuses = Array(store.outbox.prefix(100))
        let body = SyncBody(
            ack: acks,
            tasks: watching ? store.shared() : nil,
            statuses: statuses.isEmpty ? nil : statuses.map(\.wire),
            typing: nil)
        do {
            let (data, status) = try await request("POST", "/mac/sync", body: try JSONEncoder().encode(body))
            guard status == 200 else {
                lastFailed = true
                store.syncError = status == 401 ? ApiError.unauthorized.message : ApiError.status(status).message
                return
            }
            let reply = try JSONDecoder().decode(SyncReply.self, from: data)
            lastFailed = false
            if let n = reply.now { serverNow = n; serverNowAt = Date() }
            let now = Date()
            for id in acks { confirmedAt[id] = now }
            confirmedAt = confirmedAt.filter { now.timeIntervalSince($0.value) < 60 }
            store.confirmed(acks)
            store.delivered(Set(statuses.map(\.uid)))
            let wasWatching = watching
            replyWatching = reply.watching
            let changed = store.receive(reply.commands)
            store.lastSync = now
            store.syncError = nil
            // Confirm new messages right away, share the list as soon as someone opens the web,
            // and send the rest of a long outbox.
            if !reply.commands.isEmpty || (watching && !wasWatching) || (watching && changed)
                || store.outbox.count > 0 && statuses.count == 100 {
                again = true
            }
        } catch {
            lastFailed = true
            store.syncError = ApiError.offline.message
        }
    }

    private func request(_ method: String, _ path: String, body: Data?) async throws -> (Data, Int) {
        guard let url = URL(string: config.api + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: req)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private func call(_ method: String, _ path: String, json: [String: Any]?) async -> Result<Data, ApiError> {
        do {
            let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
            let (data, status) = try await request(method, path, body: body)
            switch status {
            case 200: return .success(data)
            case 401: return .failure(.unauthorized)
            case 409: return .failure(.conflict)
            default: return .failure(.status(status))
            }
        } catch {
            return .failure(.offline)
        }
    }

    // MARK: People

    func senders() async -> Result<[Sender], ApiError> {
        switch await call("GET", "/mac/senders", json: nil) {
        case .success(let data):
            guard let r = try? JSONDecoder().decode(SendersReply.self, from: data) else { return .failure(.status(200)) }
            return .success(r.senders.compactMap(\.value).filter { $0.status != "revoked" })
        case .failure(let e): return .failure(e)
        }
    }

    func inviteLink(name: String) async -> Result<InviteLink, ApiError> {
        switch await call("POST", "/mac/invite-link", json: ["name": name]) {
        case .success(let data):
            guard let r = try? JSONDecoder().decode(InviteLink.self, from: data) else { return .failure(.status(200)) }
            return .success(r)
        case .failure(let e): return .failure(e)
        }
    }

    func agentKey(name: String, key: AgentKey) async -> Result<Void, ApiError> {
        switch await call("POST", "/mac/agent-key", json: ["name": name, "keyHash": key.hash, "keyTail": key.tail]) {
        case .success: return .success(())
        case .failure(let e): return .failure(e)
        }
    }

    func revoke(senderId: String) async -> Result<Void, ApiError> {
        switch await call("POST", "/mac/sender-revoke", json: ["senderId": senderId]) {
        case .success: return .success(())
        case .failure(let e): return .failure(e)
        }
    }
}

// MARK: - Agent keys

/// A key for an agent. Only its hash and last 4 characters leave the Mac.
struct AgentKey {
    let key: String
    let hash: String
    let tail: String

    static func generate() -> AgentKey? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let b64 = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let key = "uk_" + b64
        let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return AgentKey(key: key, hash: hash, tail: String(key.suffix(4)))
    }
}

// MARK: - Live feed

/// One Convex subscription to `macFeed:get`. It is silent while nothing changes, so it counts as
/// usable once it has delivered a value since the last (re)subscribe, has not failed, and the socket is up.
@MainActor
final class LiveFeed {
    private let client: ConvexClient
    private let key: String
    private var sub: AnyCancellable?
    private var socket: AnyCancellable?
    private var lastValueAt: Date?
    private var socketUp = true
    /// When the feed stopped being usable. Nil while it is.
    private var downSince: Date? = Date()
    private var retryAt: Date?
    private var failures = 0
    var onValue: ((FeedValue) -> Void)?

    init(deploymentUrl: String, key: String) {
        client = ConvexClient(deploymentUrl: deploymentUrl)
        self.key = key
        socket = client.watchWebSocketState()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    switch state {
                    case .connected:
                        self.socketUp = true
                        if self.sub != nil, self.lastValueAt != nil { self.downSince = nil }
                    case .connecting:
                        self.socketUp = false
                        if self.downSince == nil { self.downSince = Date() }
                    }
                }
            }
    }

    var healthy: Bool { downSince == nil }

    /// How long the feed has not been usable. Zero when it is.
    func downFor(at now: Date = Date()) -> TimeInterval {
        downSince.map { now.timeIntervalSince($0) } ?? 0
    }

    /// (Re)subscribes. Until the first value arrives the feed does not count as usable.
    func start() {
        sub?.cancel()
        lastValueAt = nil
        retryAt = nil
        if downSince == nil { downSince = Date() }
        sub = client.subscribe(to: "macFeed:get", with: ["key": key], yielding: FeedValue.self)
            .receive(on: DispatchQueue.main)
            .sink(receiveCompletion: { [weak self] _ in
                // The error text is never logged: it could echo arguments.
                MainActor.assumeIsolated { self?.failed() }
            }, receiveValue: { [weak self] value in
                MainActor.assumeIsolated { self?.got(value) }
            })
    }

    /// Resubscribes after a failure, backing off up to a minute.
    func tick(now: Date = Date()) {
        if sub == nil, let r = retryAt, now >= r { start() }
    }

    private func got(_ value: FeedValue) {
        guard value.ok else { failed(); return }
        lastValueAt = Date()
        failures = 0
        if socketUp { downSince = nil }
        onValue?(value)
    }

    private func failed() {
        sub?.cancel()
        sub = nil
        if downSince == nil { downSince = Date() }
        failures += 1
        retryAt = Date().addingTimeInterval(min(60, 5 * pow(2, Double(min(failures, 6) - 1))))
    }
}

// MARK: - Presence

/// Sleep, screen lock and recent input. Decides when to poll and when the owner counts as present.
@MainActor
final class Presence {
    private(set) var asleep = false
    private(set) var lockedSince: Date?
    private(set) var displayAsleep = false
    var onWake: (() -> Void)?

    init() {
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.asleep = true }
        }
        ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.asleep = false
                self?.onWake?()
            }
        }
        ws.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.displayAsleep = true }
        }
        ws.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.displayAsleep = false }
        }
        let dc = DistributedNotificationCenter.default()
        dc.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.lockedSince == nil { self?.lockedSince = Date() } }
        }
        dc.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.lockedSince = nil }
        }
    }

    /// Asleep, or locked for more than 5 minutes: no polling at all.
    func quiet(at now: Date = Date()) -> Bool {
        asleep || (lockedSince.map { now.timeIntervalSince($0) > 300 } ?? false)
    }

    /// Unlocked, display on, keyboard or mouse used in the last minute.
    var active: Bool {
        guard !asleep, lockedSince == nil, !displayAsleep, let any = CGEventType(rawValue: UInt32.max) else { return false }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any) < 60
    }
}
