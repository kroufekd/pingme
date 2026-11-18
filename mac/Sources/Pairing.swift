// Connecting this Mac to the owner's account, through the web (docs/device-api.md, "Mac: pairing").
// The Mac makes a pair id, a secret and its key pair, opens /pair#<pairId>.<secret> in the browser,
// shows a 6-digit code the person types there, and asks every 2 s whether they approved it.
// The token comes back sealed to the pairing key. The secret stays in the URL fragment,
// which the browser never sends; the server only ever sees its hash.

import AppKit
import Foundation
import SystemConfiguration

@MainActor
final class Pairing {
    enum State: Equatable {
        case idle, starting
        /// Waiting for the browser. The code the owner types there.
        case waiting(String)
        case failed(String)
        /// Approved. The account's name.
        case done(String)
    }

    private(set) var state: State = .idle {
        didSet { if state != oldValue { onChange?() } }
    }
    private let api: DeviceAPI
    private let web: String
    private var task: Task<Void, Never>?
    private var url: URL?
    var onChange: (() -> Void)?
    var onPaired: ((DeviceIdentity) -> Void)?
    /// The token of the device this pairing replaces, dropped from the account once the new one works.
    private var replaced: String?

    static let poll: UInt64 = 2_000_000_000
    static let lifetime: TimeInterval = 600

    init(api: DeviceAPI, web: String) {
        self.api = api
        self.web = web
    }

    var busy: Bool {
        switch state {
        case .starting, .waiting: return true
        default: return false
        }
    }

    /// Starts a pairing, or brings the browser page back when one is already waiting.
    func start() {
        if busy { reopen(); return }
        task?.cancel()
        state = .starting
        task = Task { [weak self] in await self?.run() }
    }

    func cancel() {
        task?.cancel()
        task = nil
        url = nil
        state = .idle
    }

    /// The browser tab got closed: open the same page again.
    func reopen() {
        if let url { NSWorkspace.shared.open(url) }
    }

    /// Forget a finished or failed attempt, so the island offers a fresh one.
    func reset() {
        if !busy { state = .idle }
    }

    private func run() async {
        let pair = Seal.generateKeyPair()
        let identity = DeviceIdentity(privateKey: Seal.exportPrivateKey(pair.privateKey))
        // Pairing again replaces this Mac's device. The old one would otherwise stay on the account,
        // never confirm a ping, and keep the person's inbox full until each ping expires.
        // Kept here across attempts: a failed one leaves only a fresh, tokenless key in the Keychain.
        switch IdentityStore.load() {
        case .success(let old?):
            if let t = old.token { replaced = t }
        case .failure(.denied):
            // The old key is still there, only locked. Pairing now would leave that Mac on the account.
            state = .failed(KeychainError.denied(0).message)
            return
        default:
            break
        }
        do {
            // A fresh key for every pairing. The private half is in the Keychain before anything leaves the Mac.
            try IdentityStore.save(identity)
        } catch {
            state = .failed((error as? KeychainError)?.message ?? KeychainError.corrupt.message)
            return
        }
        var pairId = Net.randomB64url(16)
        var secret = Net.randomB64url(32)
        var started = false
        for _ in 0..<2 where !started {
            switch await api.pairStart(pairId: pairId, secretHash: Net.secretHash(secret), publicKey: pair.publicKey,
                                       name: Self.macName()) {
            case .success:
                started = true
            case .failure(.server(409, _)):
                // pair-exists: practically never with 16 random bytes, but cheap to handle.
                pairId = Net.randomB64url(16)
                secret = Net.randomB64url(32)
            case .failure(let e):
                if !Task.isCancelled { state = .failed(e.message) }
                return
            }
        }
        guard started, !Task.isCancelled, let url = Net.pairURL(web: web, pairId: pairId, secret: secret) else {
            if !Task.isCancelled { state = .failed(ApiError.server(409, nil).message) }
            return
        }
        self.url = url
        state = .waiting(Net.pairCode(pairId: pairId, publicKey: pair.publicKey))
        NSWorkspace.shared.open(url)

        let deadline = Date().addingTimeInterval(Self.lifetime)
        while !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: Self.poll)
            if Task.isCancelled { return }
            switch await api.pairClaim(pairId: pairId, secret: secret) {
            case .success(.pending):
                continue
            case .success(.approved(let c)):
                guard let token = try? Net.openPairToken(c.sealedToken, privateKey: pair.privateKey, pairId: pairId,
                                                         userId: c.userId) else {
                    self.url = nil
                    state = .failed("Didn't work, try again.")
                    return
                }
                var id = identity
                id.token = token
                id.deviceId = c.deviceId
                id.userId = c.userId
                id.name = c.name
                do {
                    try IdentityStore.save(id)
                } catch {
                    state = .failed((error as? KeychainError)?.message ?? KeychainError.corrupt.message)
                    return
                }
                self.url = nil
                state = .done(c.name ?? "")
                onPaired?(id)
                // Best effort: if this fails, the old device stays, but the inbox reads newest first, so it buries nothing.
                if let old = replaced, old != token {
                    replaced = nil
                    _ = await api.unpair(token: old)
                }
                return
            case .success(.gone):
                // Expired, already claimed or unknown: it never comes back.
                self.url = nil
                state = .failed("Expired, try again.")
                return
            case .failure:
                // Offline or a server hiccup: keep asking until the request expires.
                continue
            }
        }
        if !Task.isCancelled {
            self.url = nil
            state = .failed("Expired, try again.")
        }
    }

    /// The Mac's name as the pairing page shows it ("MacBook Michala"), 1 to 60 characters.
    nonisolated static func macName() -> String {
        let raw = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? Host.current().localizedName ?? ""
        var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // The server counts UTF-16 units, like JavaScript.
        while name.utf16.count > 60 { name.removeLast() }
        return name.isEmpty ? "Mac" : name
    }
}
