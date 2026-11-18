// Drives the island: which state it shows, the panel at the notch, reminders and delivery statuses.

import AppKit
import Combine
import SwiftUI

/// Borderless panels refuse the keyboard by default and get pushed below the menu bar. This one does neither.
final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// The first click on the island already presses the button, even though the app is not active.
/// Its own tracking area reports the pointer even while the app is inactive and the panel is not key.
final class IslandHostingView<Content: View>: NSHostingView<Content> {
    var onPointer: (() -> Void)?
    private var area: NSTrackingArea?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let a = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(a)
        area = a
    }

    override func mouseEntered(with event: NSEvent) { super.mouseEntered(with: event); onPointer?() }
    override func mouseExited(with event: NSEvent) { super.mouseExited(with: event); onPointer?() }
    override func mouseMoved(with event: NSEvent) { super.mouseMoved(with: event); onPointer?() }
}

/// Holds the island's SwiftUI view at one fixed size, pinned top center. The window grows and shrinks
/// around it like a crop, and SwiftUI never lays out again because of a resize. A resize used to show
/// one frame of the old layout anchored to the window's bottom: a gap under the top edge of the screen.
final class IslandCanvasView: NSView {
    static let size = CGSize(width: 720, height: 1200)
    override var isFlipped: Bool { true }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        for v in subviews {
            v.frame = NSRect(x: ((bounds.width - Self.size.width) / 2).rounded(), y: 0,
                             width: Self.size.width, height: Self.size.height)
        }
    }
}

@MainActor
final class IslandController {
    let model = IslandModel()
    private let store: TaskStore
    private let sync: SyncEngine
    private let presence: Presence
    private let bridge: AgentBridge
    private let pairing: Pairing
    private var panel: IslandPanel?
    private var screenKey = ""
    /// Top center of the island in screen coordinates.
    private var anchor = NSPoint.zero
    private var frameGeneration = 0
    /// The state the island is in or about to be in. The model follows a moment later when opening.
    private(set) var target: IslandMode = .closed
    private var settled = true
    private var knownDue = Set<String>()
    /// Due tasks the owner put away with Esc. A new arrival still opens the island.
    private var dismissed = Set<String>()
    /// The task card is open because the owner opened it (a click), not because something popped.
    /// While paused, only then does it show more than red.
    private var userOpenedTask = false
    private var nagFirst: [String: Date] = [:]
    private var nagLast: [String: Date] = [:]
    private var orangeNagged = Set<String>()
    private var activeSeconds: [String: Int] = [:]
    private var monitors: [Any] = []
    private var peekGeneration = 0
    /// A pending hover or peek change (see settlePointer).
    private var pointerWork: DispatchWorkItem?
    private var pointerWant: Bool?
    /// While the island narrows after a peek, the window keeps its wide size.
    private var peekSettleAt = Date.distantPast
    private var heightSub: AnyCancellable?
    private var typingSub: AnyCancellable?
    private var peopleAt = Date.distantPast
    /// Something changed in the store: sync and refresh the menu bar.
    var onChange: (() -> Void)?
    /// "Try again" on a locked Keychain.
    var onRetryKey: (() -> Void)?
    var keyLock: KeyLock? {
        get { model.keyLock }
        set { model.keyLock = newValue }
    }
    /// This Mac is connected to an account. Without it the island offers "Connect this Mac"
    /// in place of people; local tasks and agent sessions work either way.
    var paired = false {
        didSet {
            guard paired != oldValue else { return }
            model.contacts = []
            model.invites = []
            model.openContact = nil
            model.peopleLoad = .idle
            if !paired, target == .people { open(.pair, user: false) }
        }
    }

    private static let pad = CGSize(width: 24, height: 28)   // room for the shadow and the bump

    init(store: TaskStore, sync: SyncEngine, presence: Presence, bridge: AgentBridge, pairing: Pairing) {
        self.store = store
        self.sync = sync
        self.presence = presence
        self.bridge = bridge
        self.pairing = pairing
        heightSub = model.$height.removeDuplicates().sink { [weak self] h in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.heightChanged(h) } }
        }
        // The sender sees "typing" while the owner types a reply.
        typingSub = model.$replyText.removeDuplicates().sink { [weak self] text in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.typed(text) } }
        }
        pairing.onChange = { [weak self] in self?.pairingChanged() }
        installMonitors()
    }

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    // MARK: Tick (every second)

    func tick(now: Date = Date()) {
        place()
        updateReplyDelivery()
        var changed = false
        let due = store.due(at: now)
        let paused = Prefs.paused(at: now)
        model.privateText = Prefs.hideText || paused
        let dueIds = Set(due.map(\.id))
        // Paused: only red arrives (with its text hidden). The rest is held back, not learned, so it
        // arrives when the pause ends; what was already known before the pause does not come back.
        let incoming = dueIds.subtracting(knownDue)
        let held = paused ? Set(due.filter { $0.level != .red && incoming.contains($0.id) }.map(\.id)) : []
        let fresh = incoming.subtracting(held)
        for id in knownDue.subtracting(dueIds) {
            nagFirst[id] = nil
            nagLast[id] = nil
            orangeNagged.remove(id)
            activeSeconds[id] = nil
        }
        knownDue = dueIds.subtracting(held)
        dismissed.formIntersection(dueIds)
        model.now = now

        // Arrivals: sound for Brzy and Hned, and the island grows unless a tool state is open.
        if !fresh.isEmpty {
            for id in fresh { nagFirst[id] = now; nagLast[id] = now }
            let arrivals = due.filter { fresh.contains($0.id) }
            if (arrivals.map(\.level).max() ?? .green) >= .orange { playSound() }
            if let first = arrivals.first { announce(first) }
            if target == .closed { open(.task, user: false) }
        }

        if target == .task {
            // While paused the island keeps to red, unless the owner opened it to look.
            let shown = paused && !userOpenedTask ? due.filter { $0.level == .red } : due
            if shown.isEmpty { close() } else { pickCurrent(shown) }
        }

        // Reminders until the owner clicks. Orange once after 2 min, red every minute.
        for t in due where t.touchedAt == nil && (!paused || t.level == .red) {
            guard let first = nagFirst[t.id] else { continue }
            if t.level == .orange, !orangeNagged.contains(t.id), now.timeIntervalSince(first) >= 120 {
                orangeNagged.insert(t.id)
                nag(t)
            } else if t.level == .red, now.timeIntervalSince(nagLast[t.id] ?? first) >= 60 {
                nagLast[t.id] = now
                nag(t)
            }
        }

        // Delivery statuses for senders.
        let onIsland = target == .task ? model.current?.id : nil
        if let id = onIsland, let t = store.task(id) {
            if t.stage != "popped" { store.markPopped(id); changed = true }
            if t.seenAt == nil, presence.active, panel?.isVisible == true {
                activeSeconds[id, default: 0] += 1
                if activeSeconds[id, default: 0] >= 5 { store.markSeen(id); changed = true }
            }
        }
        for t in store.pending where t.taskRef != nil && t.stage == nil && t.id != onIsland {
            store.markWaiting(t.id)
            changed = true
        }

        // Idle dot: everything Waiting lists plus due tasks that are not on the island.
        let rest = store.pending.filter { $0.id != onIsland }
        model.earsCount = rest.count
        model.earsUrgency = rest.map(\.level).max() ?? .green
        model.waitingCount = store.waiting(at: now).count
        if target == .waiting { model.waitingRows = store.waiting(at: now) }
        // Online dots go stale: refresh the list while it is open.
        if target == .people, paired, now.timeIntervalSince(peopleAt) >= 30 { loadPeople() }
        // A missed exit event must not leave the island hovered or peeking. Only turns things off:
        // a pointer parked at the top of the screen must not count as someone looking.
        updatePointer(onlyClear: true)
        if target == .closed && settled && !model.peek && now >= peekSettleAt { applyFrame() }
        if changed { onChange?() }
    }

    /// Keeps the task the owner is working on; otherwise shows the most urgent one.
    private func pickCurrent(_ due: [TodoTask]) {
        if let cur = model.current, let still = due.first(where: { $0.id == cur.id }),
           still.touchedAt != nil || !model.replyText.isEmpty {
            if still != cur { model.current = still }
            return
        }
        guard let top = due.first else { return }
        if model.current?.id != top.id { setCurrent(top) } else if model.current != top { model.current = top }
    }

    /// The reply on the current task: still in the outbox, or taken by the server. The sender sees it on
    /// their web page or Mac, so an offline sender is said, not hidden behind "Sent".
    private func updateReplyDelivery() {
        guard let t = model.current, t.reply != nil, let ref = t.taskRef, !t.isAgentSession else {
            if !model.replyDelivery.isEmpty { model.replyDelivery = "" }
            return
        }
        let text: String
        if store.outbox.contains(where: { $0.isReply && $0.taskRef == ref }) {
            text = store.syncError == nil ? "Sending" : "Waiting for the connection"
        } else if let c = sync.contacts?.contacts.first(where: { $0.userId == t.fromUserId }), c.hasMac, !c.online {
            // Without a Mac they read it on the web, whenever they look: plain "Sent" says it.
            text = "Sent, shows when \(Fmt.firstName(c.name))'s Mac is on"
        } else {
            text = "Sent"
        }
        if model.replyDelivery != text { model.replyDelivery = text }
    }

    private func setCurrent(_ t: TodoTask) {
        model.current = t
        model.replyText = ""
        model.replyOpen = false
        model.chosenChip = t.reply.flatMap { kReplyChips.contains($0) ? $0 : nil }
        model.sentNote = t.reply ?? ""
        model.shown = .task
    }

    private func nag(_ t: TodoTask) {
        playSound()
        if target == .closed {
            dismissed.remove(t.id)
            open(.task, user: false)
            setCurrent(t)
        } else if target == .task, model.current?.id != t.id, model.replyText.isEmpty {
            setCurrent(t)
        }
        bump()
    }

    private func playSound() { NSSound(named: NSSound.Name("Glass"))?.play() }

    private func announce(_ t: TodoTask) {
        let text = "\(t.fromName)\(TaskCard.marker(t).map { ", \($0)" } ?? ""), \(t.level.word): \(t.title)"
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    // MARK: Open and close

    /// Click on the notch or the menu bar item: the task when one is due, otherwise a new task
    /// (or "Connect this Mac" while this Mac is not connected).
    func openFromUser(_ preferred: IslandMode = .compose) {
        let due = store.due()
        if !due.isEmpty {
            dismissed.removeAll()
            if target != .task { open(.task, user: true) }
            pickCurrent(due)
        } else {
            open(!paired && preferred == .compose ? .pair : preferred, user: true)
        }
    }

    func open(_ requested: IslandMode, user: Bool) {
        let mode: IslandMode = requested == .people && !paired ? .pair : requested
        if mode == .task { userOpenedTask = user || (userOpenedTask && target == .task) }
        let p = panel ?? makePanel()
        panel = p
        place()
        switch mode {
        case .task: if let top = store.due().first, model.current.map({ store.due().map(\.id).contains($0.id) }) != true { setCurrent(top) }
        case .waiting: model.waitingRows = store.waiting()
        case .people: loadPeople()
        case .pair: model.pair = pairing.state
        case .compose: refreshPingable()
        case .closed: break
        }
        if model.shown == .people && mode != .people { forgetKey() }
        if model.shown != mode { model.hoverRow = nil }
        peekGeneration += 1
        model.peek = false
        let wasClosed = model.mode == .closed
        target = mode
        if wasClosed {
            var quiet = Transaction()
            quiet.disablesAnimations = true
            withTransaction(quiet) { model.shown = mode }
        } else {
            model.shown = mode
        }
        frameGeneration += 1
        settled = false
        applyFrame(open: true)
        p.orderFrontRegardless()
        if wasClosed {
            // Start closed, then open a moment later so the growth is animated.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
                guard let self, self.target == mode else { return }
                self.model.mode = mode
            }
        } else {
            model.mode = mode
        }
        if user {
            p.makeKey()
            if mode == .compose { model.focusRequest += 1 }
        }
    }

    /// Folds the island back into the notch.
    func close() {
        guard target != .closed else { return }
        userOpenedTask = false
        if model.shown == .people { forgetKey() }
        frameGeneration += 1
        let g = frameGeneration
        target = .closed
        model.mode = .closed
        model.hover = false
        model.taskFocused = false
        model.replyOpen = false
        model.hoverRow = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0.15 : kIslandSettle)) { [weak self] in
            guard let self, g == self.frameGeneration, self.target == .closed, let p = self.panel else { return }
            self.settled = true
            // Give the keyboard back to whatever had it.
            if p.isKeyWindow { p.orderOut(nil) }
            self.applyFrame()
        }
    }

    /// Closing a tool state shows a due task if there is one.
    private func closeTool() {
        let paused = Prefs.paused()
        let due = store.due().filter { !paused || $0.level == .red }
        if due.contains(where: { !dismissed.contains($0.id) }) {
            open(.task, user: false)
            pickCurrent(due)
        } else {
            close()
        }
    }

    private func handleEscape() {
        switch target {
        case .task:
            // Esc in an open reply only goes back to the task.
            if model.replyOpen {
                model.replyOpen = false
                model.replyText = ""
                return
            }
            if let c = model.current { store.touch(c.id); onChange?() }
            dismissed = knownDue
            close()
        case .compose, .waiting, .people, .pair:
            closeTool()
        case .closed:
            break
        }
    }

    private func bump() {
        guard !reduceMotion, target != .closed else { return }
        model.bumped = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in self?.model.bumped = false }
    }

    // MARK: Actions from the island

    lazy var actions = IslandActions(
        done: { [weak self] id in self?.done(id) },
        snooze: { [weak self] id in self?.snooze(id) },
        reply: { [weak self] id, text in self?.reply(id, text) },
        open: { [weak self] id in self?.openSession(id) },
        wantKeyboard: { [weak self] in self?.panel?.makeKey() },
        openFromNotch: { [weak self] in self?.openFromUser(.compose) },
        openWaiting: { [weak self] in self?.openFromUser(.waiting) },
        switchTo: { [weak self] m in self?.open(m, user: true) },
        add: { [weak self] in self?.add() },
        invite: { [weak self] in self?.invite() },
        revokeInvite: { [weak self] id in self?.revokeInvite(id) },
        toggleContact: { [weak self] id in self?.toggleContact(id) },
        removeContact: { [weak self] id in self?.removeContact(id) },
        pair: { [weak self] in self?.pairing.start() },
        cancelPair: { [weak self] in self?.pairing.cancel() },
        retryKey: { [weak self] in self?.onRetryKey?() },
        openKeychain: {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.keychainaccess") {
                NSWorkspace.shared.openApplication(at: url, configuration: .init())
            }
        })

    /// The key came back after "Try again": the pair card has nothing left to say.
    func keyUnlocked() {
        keyLock = nil
        if target == .pair { closeTool() }
    }

    private func done(_ id: String) {
        store.markDone(id)
        model.replyText = ""
        onChange?()
        tick()
    }

    private func snooze(_ id: String) {
        store.snooze(id)
        model.replyText = ""
        onChange?()
        tick()
    }

    private func reply(_ id: String, _ text: String) {
        if let t = store.task(id), t.isAgentSession, let session = t.agentSession {
            replyToSession(id, session, text)
            return
        }
        store.reply(id, text: text)
        let sent = store.task(id)?.reply ?? text
        model.chosenChip = kReplyChips.contains(sent) ? sent : nil
        model.sentNote = sent
        model.replyText = ""
        model.replyOpen = false
        if let t = store.task(id) { model.current = t }
        onChange?()
    }

    /// Into the session's socket. Only what the owner typed.
    private func replyToSession(_ id: String, _ session: String, _ text: String) {
        let text = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        guard !text.isEmpty else { return }
        model.replyText = ""
        model.replyOpen = false
        model.chosenChip = nil
        bridge.send(session: session, text: text) { [weak self] ok in
            guard let self else { return }
            if ok {
                self.store.reply(id, text: text)
                self.model.sentNote = String(text.prefix(kReplyMax))
                self.done(id)
            } else {
                self.model.sentNote = "That session is no longer running. Open it."
                if let t = self.store.task(id) { self.model.current = t }
            }
        }
    }

    private func openSession(_ id: String) {
        guard let t = store.task(id), let session = t.agentSession else { return }
        bridge.open(session: session)
        // A finished session is handled by opening it. A message for the agent still waits for an answer to its sender.
        if t.isAgentSession { done(id) } else { store.touch(id); onChange?() }
    }

    private func hovered() {
        guard target == .task, presence.active, let id = model.current?.id, store.task(id)?.seenAt == nil else { return }
        store.markSeen(id)
        onChange?()
    }

    /// Contacts for the compose "To" menu: the last list right away, a fresh one when it is old.
    private func refreshPingable() {
        if !model.composeBusy { model.composeNote = "" }
        guard paired else { model.newTo = nil; return }
        if let c = sync.contacts { model.contacts = ContactRow.list(c) }
        guard Date().timeIntervalSince(sync.contactsAt) > 120 else { return }
        Task { @MainActor [weak self] in
            guard let self, case .success(let c) = await self.sync.loadContacts() else { return }
            self.model.contacts = ContactRow.list(c)
            if let to = self.model.newTo, !self.model.contacts.contains(where: { $0.id == to && $0.hasMac }) { self.model.newTo = nil }
        }
    }

    /// The compose text goes to a contact's Mac instead of this one. The text stays until it went.
    private func sendPing(to userId: String, text: String, due: Date?) {
        guard !model.composeBusy else { return }
        let first = Fmt.firstName(model.contacts.first { $0.id == userId }?.name ?? "them")
        model.composeBusy = true
        model.composeNote = "Sending to \(first)..."
        let urgency = model.newUrgency
        Task { @MainActor [weak self] in
            guard let self else { return }
            let r = await self.sync.ping(to: userId, text: text, urgency: urgency, dueAt: due)
            self.model.composeBusy = false
            switch r {
            case .success(let sent):
                // Watched from when it shows on their Mac, so a ping for next week still gets its reply.
                ReplyWatch.add(sent.ref, at: max(Date().ms, due?.ms ?? 0))
                let online = sent.target.online
                let scheduled = (due?.timeIntervalSinceNow ?? 0) > 30
                self.model.composeNote = scheduled ? "Sent. \(first) sees it at the time you picked."
                    : online ? "Sent to \(first)." : "Sent. \(first) sees it when their Mac is back."
                self.model.newTitle = ""
                self.model.newUrgency = .green
                self.model.later = false
                // The next new thing is a note to self again, unless they pick someone.
                self.model.newTo = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
                    guard let self, self.target == .compose, self.model.newTitle.isEmpty, !self.model.composeBusy else { return }
                    self.model.composeNote = ""
                    self.closeTool()
                }
            case .failure(let f):
                self.model.composeNote = Self.pingProblem(f, name: first)
            }
        }
    }

    static func pingProblem(_ f: MCPTools.SendFailure, name: String) -> String {
        switch f {
        case .noMac: return "\(name) has no Mac app yet, so the ping cannot reach them."
        case .rateLimited: return "That is 30 pings to \(name) this hour. Try again later."
        case .notContact: return "\(name) is not your contact any more."
        case .unstable: return "\(name)'s Macs keep changing. Try again in a minute."
        case .seal: return "Could not encrypt it. Nothing was sent."
        case .api(.offline): return "No connection. Nothing was sent; try again."
        case .api(.unauthorized): return "This Mac is not connected any more. Connect it again."
        case .api(.server): return "The server refused it. Nothing was sent."
        }
    }

    private func add() {
        let title = model.newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        if let to = model.newTo {
            sendPing(to: to, text: title, due: model.later ? model.laterDate : nil)
            return
        }
        let due = model.later ? model.laterDate : Date()
        store.add(title: title, dueAt: due, urgency: model.newUrgency)
        model.newTitle = ""
        model.newUrgency = .green
        model.later = false
        onChange?()
        closeTool()
        tick()
    }

    private func typed(_ text: String) {
        guard !text.isEmpty, target == .task, let t = model.current, let ref = t.taskRef, !t.isAgentSession else { return }
        sync.typing(ref)
    }

    // MARK: Pairing

    private func pairingChanged() {
        model.pair = pairing.state
        guard case .done = pairing.state else { return }
        // Say it worked where the owner looks (the island may have folded while they were in the browser).
        if target == .closed { open(.pair, user: false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            guard let self else { return }
            if self.target == .pair { self.closeTool() }
            // Only once the island has folded, or "Connected" would flash back to the button.
            DispatchQueue.main.asyncAfter(deadline: .now() + kIslandSettle) { [weak self] in self?.pairing.reset() }
        }
    }

    // MARK: People

    private func loadPeople() {
        peopleAt = Date()
        if model.contacts.isEmpty && model.invites.isEmpty { model.peopleLoad = .loading }
        Task {
            async let c = sync.loadContacts()
            async let i = sync.invites()
            let (contacts, invites) = await (c, i)
            switch contacts {
            case .success(let reply):
                model.contacts = ContactRow.list(reply)
                model.myKey = sync.identity.flatMap { try? $0.key() }.flatMap { Net.fingerprint(Seal.publicKey(of: $0)) }
                if let id = model.openContact, !model.contacts.contains(where: { $0.id == id }) { model.openContact = nil }
                model.peopleLoad = .loaded
            case .failure(let e):
                if model.contacts.isEmpty { model.peopleLoad = .failed(e.message) }
            }
            if case .success(let list) = invites { model.invites = list }
        }
    }

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    private func forgetKey() {
        model.said = ""
        model.saidOK = false
        model.openContact = nil
    }

    private func invite() {
        var name = model.personName.trimmingCharacters(in: .whitespacesAndNewlines)
        while name.utf16.count > kNameMax { name.removeLast() }
        guard !name.isEmpty, !model.busy else { return }
        model.busy = true
        Task {
            let r = await sync.createInvite(name: name)
            model.busy = false
            switch r {
            case .success(let link):
                // Shown once: the server keeps only the hash of the link.
                copy(link.url)
                model.said = "Link copied, good for 7 days."
                model.saidOK = true
                model.personName = ""
                loadPeople()
            case .failure(let e):
                model.said = e.code == "too-many-invites" ? "Too many open invites." : e.message
                model.saidOK = false
            }
        }
    }

    private func revokeInvite(_ id: String) {
        Task {
            switch await sync.revokeInvite(id) {
            case .success, .failure(.server(404, _)):
                model.invites.removeAll { $0.id == id }
            case .failure(let e):
                model.said = e.message
                model.saidOK = false
            }
        }
    }

    /// Ends a contact both ways: neither can ping the other any more.
    private func removeContact(_ id: String) {
        Task {
            switch await sync.removeContact(id) {
            case .success, .failure(.server(404, _)):
                model.contacts.removeAll { $0.id == id }
                if model.openContact == id { model.openContact = nil }
            case .failure(let e):
                model.said = e.message
                model.saidOK = false
            }
        }
    }

    /// A contact's detail: the key fingerprints, to compare in person.
    private func toggleContact(_ id: String) {
        model.openContact = model.openContact == id ? nil : id
    }

    // MARK: Pointer

    /// The island's rectangle on screen, as drawn now.
    private func islandRect() -> NSRect? {
        let size: CGSize
        if target == .closed {
            guard let s = model.metrics.closedSize(count: model.earsCount, peek: model.peek) else { return nil }
            size = s
        } else {
            size = CGSize(width: kIslandWidth, height: model.height)
        }
        return NSRect(x: anchor.x - size.width / 2, y: anchor.y - size.height, width: size.width, height: size.height)
    }

    /// Hover on an open island reveals its hidden parts (and counts as seen for a task).
    /// Hover on the closed one makes it peek: a little wider, with a plus.
    func updatePointer(onlyClear: Bool = false) {
        guard let inside = pointerInside() else {
            cancelPointerWork()
            if model.hover { model.hover = false }
            if model.peek { setPeek(false) }
            return
        }
        if onlyClear && inside { return }
        if target == .closed {
            if model.hover { model.hover = false }
            guard settled else { return }
            // Peek after a short pause (passing by does nothing), fold after a short grace.
            settlePointer(inside, current: model.peek, on: 0.06, off: 0.18) { [weak self] v in self?.setPeek(v) }
        } else {
            if model.peek { model.peek = false }
            // A pointer only passing through (to a display above, say) does not unfold the buttons.
            settlePointer(inside, current: model.hover, on: 0.16, off: 0.15) { [weak self] v in
                guard let self else { return }
                self.model.hover = v
                if v { self.hovered() }
            }
        }
    }

    /// Whether the pointer is over the island. Once hover or peek is on, the pointer has to leave a
    /// slightly larger area to turn it off, so a pointer resting on the edge does not make it twitch.
    private func pointerInside() -> Bool? {
        guard let p = panel, p.isVisible, let rect = islandRect() else { return nil }
        let on = target == .closed ? model.peek : model.hover
        return (on ? rect.insetBy(dx: -8, dy: -6) : rect.insetBy(dx: -1, dy: -1)).contains(NSEvent.mouseLocation)
    }

    private func settlePointer(_ want: Bool, current: Bool, on: Double, off: Double, apply: @escaping (Bool) -> Void) {
        guard want != current else { cancelPointerWork(); return }
        if pointerWant == want, pointerWork != nil { return }
        cancelPointerWork()
        let delay = want ? on : off
        if delay <= 0 { apply(want); return }
        pointerWant = want
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pointerWork = nil
            self.pointerWant = nil
            // The pointer may have come back in the meantime.
            guard let inside = self.pointerInside(), inside == want else { return }
            if self.target == .closed && !self.settled { return }
            apply(want)
        }
        pointerWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelPointerWork() {
        pointerWork?.cancel()
        pointerWork = nil
        pointerWant = nil
    }

    private func setPeek(_ on: Bool) {
        peekGeneration += 1
        let g = peekGeneration
        if on {
            // Grow the window first, so the wider island has room to animate into.
            model.peek = true
            applyFrame()
        } else {
            model.peek = false
            // Long enough for the peek spring to settle, so the window never cuts the island mid-motion.
            let wait = reduceMotion ? 0 : kIslandSettle
            peekSettleAt = Date().addingTimeInterval(wait)
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                guard let self, g == self.peekGeneration, self.target == .closed, !self.model.peek else { return }
                self.applyFrame()
            }
        }
    }

    // MARK: Panel

    /// The island lives on the MacBook's own display, on its notch. Without one (lid closed, or no
    /// built-in display) it hangs top center under the menu bar of the main screen.
    func place(force: Bool = false) {
        let screen = NSScreen.builtIn ?? NSScreen.main
        let key = screen.map { NSStringFromRect($0.frame) + NSStringFromRect($0.visibleFrame) } ?? ""
        guard force || key != screenKey, let s = screen else { return }
        screenKey = key
        var quiet = Transaction()
        quiet.disablesAnimations = true
        let m = IslandMetrics.forScreen(s)
        withTransaction(quiet) { model.metrics = m }
        anchor = NSPoint(x: s.frame.midX, y: m.hasNotch ? s.frame.maxY : s.visibleFrame.maxY)
        applyFrame(open: target != .closed)
    }

    private func heightChanged(_ h: CGFloat) {
        guard target != .closed, let p = panel else { return }
        let want = h + Self.pad.height
        if want > p.frame.height {
            applyFrame(open: true)
        } else {
            // Let the island shrink first, then take the window in.
            frameGeneration += 1
            let g = frameGeneration
            DispatchQueue.main.asyncAfter(deadline: .now() + kIslandSettle) { [weak self] in
                guard let self, g == self.frameGeneration, self.target != .closed else { return }
                self.applyFrame(open: true)
            }
        }
    }

    /// Open: the full island. Closed: just the notch (or the dot and count), so the rest of the
    /// menu bar stays clickable.
    private func applyFrame(open: Bool = false) {
        guard let p = panel ?? (model.earsCount > 0 || model.metrics.hasNotch ? makePanel() : nil) else { return }
        panel = p
        let m = model.metrics
        let size: CGSize
        if open {
            size = CGSize(width: kIslandWidth + 2 * Self.pad.width, height: model.height + Self.pad.height)
        } else if let s = m.closedSize(count: model.earsCount, peek: model.peek) {
            // While it peeks the window already has the wide size; it shrinks after the island has.
            size = model.peek ? (m.closedSize(count: model.earsCount, peek: true) ?? s) : s
        } else {
            if p.isVisible { p.orderOut(nil) }
            return
        }
        let frame = NSRect(x: anchor.x - size.width / 2, y: anchor.y - size.height, width: size.width, height: size.height)
        if p.frame != frame { p.setFrame(frame, display: true) }
        if !p.isVisible { p.orderFrontRegardless() }
    }

    private func makePanel() -> IslandPanel {
        let p = IslandPanel(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.isMovable = false
        p.animationBehavior = .none
        // Above the menu bar and its status items, so it can sit on the notch.
        p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.becomesKeyOnlyIfNeeded = true
        p.appearance = NSAppearance(named: .darkAqua)
        p.setAccessibilityLabel("pingme")
        let host = IslandHostingView(rootView: IslandView(model: model, actions: actions))
        host.sizingOptions = []
        host.onPointer = { [weak self] in MainActor.assumeIsolated { self?.updatePointer() } }
        let canvas = IslandCanvasView(frame: NSRect(origin: .zero, size: p.frame.size))
        canvas.wantsLayer = true
        canvas.autoresizesSubviews = true
        canvas.addSubview(host)
        canvas.resizeSubviews(withOldSize: canvas.bounds.size)
        p.contentView = canvas
        panel = p
        return p
    }

    private func installMonitors() {
        // Clicks and keys on the island: Esc closes it, any click counts as "seen it" and stops reminders.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown], handler: { [weak self] e in
            let isEscape = e.type == .keyDown && e.keyCode == 53
            let movesFocus = e.type == .keyDown && InputMode.movesFocus(e.keyCode)
            let isClick = e.type != .keyDown
            let window = e.window
            let swallow = MainActor.assumeIsolated { () -> Bool in
                guard let self, let p = self.panel, window === p else { return false }
                // Focus rings show after Tab or arrows, and go away with the next click.
                if movesFocus {
                    InputMode.shared.keyboard = true
                } else if isClick, InputMode.shared.keyboard {
                    InputMode.shared.keyboard = false
                }
                if isEscape {
                    self.handleEscape()
                    return true
                }
                if self.target == .task, let c = self.model.current, self.store.task(c.id)?.touchedAt == nil {
                    self.store.touch(c.id)
                    self.onChange?()
                }
                return false
            }
            return swallow ? nil : e
        }) { monitors.append(m) }
        // A click anywhere else closes the tool states. A task stays until it is dealt with.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                // A waiting pairing stays open: the owner is clicking in the browser and needs the code
                // in sight. Escape or Cancel still put it away.
                if self.target == .pair, self.pairing.busy { return }
                if [.compose, .waiting, .people, .pair].contains(self.target) { self.closeTool() }
            }
        }) { monitors.append(m) }
    }
}
