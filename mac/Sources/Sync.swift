// Connection to the network: the live feed (Convex subscription `devices:feed`) and /device/sync,
// /device/reply, contacts and invites. Pings arrive sealed for this Mac and are opened here; replies
// are sealed here for every device of the ping's sender. The token never goes into a log or a message.

import AppKit
import Combine
import ConvexMobile
import Foundation

@MainActor
final class SyncEngine {
    private let store: TaskStore
    let api: DeviceAPI
    private var inFlight = false
    private var again = false
    private(set) var lastAttempt = Date.distantPast
    private(set) var lastFailed = false
    /// Paired identity. Nil: no sync at all.
    private(set) var identity: DeviceIdentity?
    private var key: Seal.PrivateKey?
    /// Pings the server confirmed as acked, so a late feed value does not trigger another sync.
    private var confirmedAt: [String: Date] = [:]
    /// Last contact list: reply targets and the people state.
    private(set) var contacts: ContactsReply?
    private var contactsAt = Date.distantPast
    private var typingRef: String?
    private var typingSentAt = Date.distantPast
    var onSynced: (() -> Void)?
    /// The server no longer knows this Mac (401): drop the token, show "Připojit tento Mac".
    var onUnauthorized: (() -> Void)?

    init(store: TaskStore, api: DeviceAPI) {
        self.store = store
        self.api = api
    }

    var paired: Bool { identity?.paired == true && key != nil }

    func setIdentity(_ id: DeviceIdentity?) {
        identity = id?.paired == true ? id : nil
        key = identity.flatMap { try? $0.key() }
        contacts = nil
        contactsAt = .distantPast
    }

    func recentlyConfirmed(_ ref: String) -> Bool {
        guard let at = confirmedAt[ref] else { return false }
        return Date().timeIntervalSince(at) < 30
    }

    /// Opens pings with this Mac's key. Anything that does not open becomes a placeholder.
    func open(_ items: [InboxItem]) -> [IncomingPing] { items.map { Net.open($0, key: key) } }

    /// Sync right away when there is something to send.
    func noteLocalChange() {
        if !store.outbox.isEmpty { syncNow() }
    }

    /// The owner is typing a reply: the sender sees "píše" for a few seconds.
    func typing(_ ref: String) {
        guard paired, Date().timeIntervalSince(typingSentAt) >= 4 else { return }
        typingRef = ref
        typingSentAt = Date()
        syncNow()
    }

    func syncNow() { Task { await self.sync() } }

    func sync() async {
        guard paired else { return }
        if inFlight { again = true; return }
        inFlight = true
        var rounds = 0
        repeat {
            again = false
            rounds += 1
            lastAttempt = Date()
            await roundTrip()
        } while again && rounds < 4 && paired
        inFlight = false
        onSynced?()
    }

    /// Only for the token in use: a call still in flight from before an unpair and a new pairing
    /// must not throw the new identity away.
    private func unauthorized(_ token: String) {
        lastFailed = true
        guard identity?.token == token else { return }
        onUnauthorized?()
    }

    private func roundTrip() async {
        guard let token = identity?.token else { return }
        let acks = Array(store.acks.prefix(100))
        let statuses = Array(store.outbox.filter { !$0.isReply }.prefix(100))
        let typing = typingRef
        typingRef = nil
        switch await api.sync(token: token, ack: acks, statuses: statuses.map(\.wire), typing: typing) {
        case .failure(.unauthorized):
            unauthorized(token)
            return
        case .failure(let e):
            lastFailed = true
            store.syncError = e.message
            return
        case .success(let reply):
            lastFailed = false
            let now = Date()
            for ref in acks { confirmedAt[ref] = now }
            confirmedAt = confirmedAt.filter { now.timeIntervalSince($0.value) < 60 }
            store.confirmed(acks)
            // Malformed or foreign statuses are skipped by the server: the whole batch is done.
            store.delivered(Set(statuses.map(\.uid)))
            let fresh = reply.messages.filter { !store.acks.contains($0.ref) }
            let changed = store.receive(open(reply.messages))
            store.lastSync = now
            store.syncError = nil
            // Ack new pings right away, and send the rest of a long outbox.
            if !fresh.isEmpty || changed || store.outbox.filter({ !$0.isReply }).count > 0 && statuses.count == 100 {
                again = true
            }
        }
        await sendReplies(token: token)
    }

    // MARK: Replies

    /// Seals and sends queued replies, oldest first. Stops at the first one that has to wait.
    private func sendReplies(token: String) async {
        for event in store.outbox.filter(\.isReply) {
            guard paired else { return }
            switch await sendReply(event, token: token) {
            case .delivered, .drop:
                store.delivered([event.uid])
            case .unauthorized:
                unauthorized(token)
                return
            case .retryLater, .reseal:
                lastFailed = true
                return
            }
        }
    }

    private func sendReply(_ e: StatusEvent, token: String) async -> Net.Outcome {
        let text = Net.cap(e.reply ?? "")
        guard !text.isEmpty else { return .drop }
        if Net.sendsPlain(e) {
            guard let r = try? await api.reply(token: token, ref: e.taskRef, at: e.at, envelopes: nil, text: text) else {
                return .retryLater
            }
            return Net.outcome(status: r.status, error: r.error)
        }
        // A v2 status without the ping's users can never be sealed.
        guard let from = e.from, let to = e.to else { return .drop }
        var devices: [DeviceInfo]
        switch await senderDevices(from) {
        case .success(let list?): devices = list
        case .success(nil): return .drop          // no longer a contact
        case .failure(.unauthorized): return .unauthorized
        case .failure: return .retryLater
        }
        for attempt in 0..<2 {
            guard !devices.isEmpty,
                  let envelopes = try? Net.sealReply(text, ref: e.taskRef, pingFrom: from, pingTo: to, devices: devices)
            else { return .drop }
            guard let r = try? await api.reply(token: token, ref: e.taskRef, at: e.at, envelopes: envelopes, text: nil) else {
                return .retryLater
            }
            let o = Net.outcome(status: r.status, error: r.error)
            // Sealed for devices that are gone: once more for the list the server sent, then give up.
            guard o == .reseal else { return o }
            guard attempt == 0 else { return .drop }
            devices = r.staleDevices.devices
            contactsAt = .distantPast
        }
        return .drop
    }

    /// Every active device of the ping's sender (or your own, for a ping to yourself).
    /// Nil inside success: not a contact any more.
    private func senderDevices(_ userId: String) async -> Result<[DeviceInfo]?, ApiError> {
        if let list = contacts?.devices(of: userId), Date().timeIntervalSince(contactsAt) < 60 { return .success(list) }
        return await loadContacts().map { $0.devices(of: userId) }
    }

    // MARK: People

    func loadContacts() async -> Result<ContactsReply, ApiError> {
        guard let token = identity?.token else { return .failure(.unauthorized) }
        let r = await api.contacts(token: token)
        switch r {
        case .success(let c):
            guard identity?.token == token else { break }
            contacts = c
            contactsAt = Date()
        case .failure(.unauthorized):
            unauthorized(token)
        case .failure:
            break
        }
        return r
    }

    func invites() async -> Result<[Invite], ApiError> {
        guard let token = identity?.token else { return .failure(.unauthorized) }
        let r = await api.invites(token: token)
        if case .failure(.unauthorized) = r { unauthorized(token) }
        return r
    }

    func createInvite(name: String) async -> Result<InviteCreated, ApiError> {
        guard let token = identity?.token else { return .failure(.unauthorized) }
        let r = await api.createInvite(token: token, name: name)
        if case .failure(.unauthorized) = r { unauthorized(token) }
        return r
    }

    func revokeInvite(_ id: String) async -> Result<Void, ApiError> {
        guard let token = identity?.token else { return .failure(.unauthorized) }
        let r = await api.revokeInvite(token: token, inviteId: id)
        if case .failure(.unauthorized) = r { unauthorized(token) }
        return r
    }

    /// Best effort: the token stops working on the server. The caller forgets it locally either way.
    func unpair() async {
        guard let token = identity?.token else { return }
        _ = await api.unpair(token: token)
    }
}

// MARK: - Live feed

/// What `devices:feed` returns. Decoded leniently: a decode error would end the subscription.
struct FeedValue: Decodable {
    var ok: Bool
    var messages: [InboxItem]

    private enum K: String, CodingKey { case ok, messages }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        messages = ((try? c.decodeIfPresent([Lossy<InboxItem>].self, forKey: .messages)) ?? []).compactMap(\.value)
    }
}

/// One Convex subscription to `devices:feed`. It is silent while nothing changes, so it counts as
/// usable once it has delivered a value since the last (re)subscribe, has not failed, and the socket is up.
@MainActor
final class LiveFeed {
    private let client: ConvexClient
    /// The device token. Nil: not paired, no subscription.
    private var token: String?
    private var sub: AnyCancellable?
    private var socket: AnyCancellable?
    private var lastValueAt: Date?
    private var socketUp = true
    /// When the feed stopped being usable. Nil while it is.
    private var downSince: Date? = Date()
    private var retryAt: Date?
    private var failures = 0
    var onValue: ((FeedValue) -> Void)?

    init(deploymentUrl: String) {
        client = ConvexClient(deploymentUrl: deploymentUrl)
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

    /// Pairs the feed with a token, or stops it (nil).
    func use(token: String?) {
        self.token = token
        if token == nil { stop() } else { start() }
    }

    func stop() {
        sub?.cancel()
        sub = nil
        retryAt = nil
        failures = 0
        lastValueAt = nil
        if downSince == nil { downSince = Date() }
    }

    /// (Re)subscribes. Until the first value arrives the feed does not count as usable.
    func start() {
        sub?.cancel()
        lastValueAt = nil
        retryAt = nil
        if downSince == nil { downSince = Date() }
        guard let token else { sub = nil; return }
        sub = client.subscribe(to: "devices:feed", with: ["token": token], yielding: FeedValue.self)
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
        if sub == nil, token != nil, let r = retryAt, now >= r { start() }
    }

    private func got(_ value: FeedValue) {
        // ok:false means the token is not valid; /device/sync decides (401) and unpairs.
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
