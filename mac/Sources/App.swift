// The app: a menu bar item and the island. No windows.

import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let store = TaskStore(fileURL: TaskStore.defaultURL())
    private var config = AppConfig()
    private var sync: SyncEngine!
    private var feed: LiveFeed!
    private var pairing: Pairing!
    private var presence: Presence!
    private var island: IslandController!
    private var bridge: AgentBridge!
    private var triage: Triage!
    private var statusItem: NSStatusItem!
    private var tickTimer: Timer?
    /// The contact list is checked this often for people who joined or connected a Mac.
    private var contactsCheckedAt = Date.distantPast
    private var repliesCheckedAt = Date.distantPast
    private var lastStatus = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        let me = NSRunningApplication.current
        if let bid = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: bid).contains(where: { $0 != me }) {
            exit(0)
        }
        config = AppConfig.load()
        installMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        let api = DeviceAPI(base: config.apiURL)
        presence = Presence()
        sync = SyncEngine(store: store, api: api)
        feed = LiveFeed(deploymentUrl: config.convexURL)
        pairing = Pairing(api: api, web: config.webURL)
        feed.onValue = { [weak self] value in self?.feedValue(value) }
        bridge = AgentBridge(dataDir: TaskStore.dataDir())
        bridge.onRecap = { [weak self] in self?.tick() }
        triage = Triage(dataDir: TaskStore.dataDir())
        triage.onFinish = { [weak self] in self?.tick() }
        island = IslandController(store: store, sync: sync, presence: presence, bridge: bridge, pairing: pairing)
        island.onChange = { [weak self] in
            self?.sync.noteLocalChange()
            self?.updateStatusItem()
        }
        island.onRetryKey = { [weak self] in self?.retryKey() }
        sync.onContacts = { [weak self] reply in self?.contactsLoaded(reply.contacts) }
        sync.onSynced = { [weak self] in self?.tick() }
        sync.onUnauthorized = { [weak self] in self?.forgetDevice(show: true) }
        pairing.onPaired = { [weak self] id in self?.usePaired(id) }
        presence.onWake = { [weak self] in
            // The socket may be stale after sleep: resubscribe, and poll until the feed answers.
            self?.feed.start()
            self?.sync.syncNow()
        }

        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.tick()
                self?.schedule()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        tickTimer = t
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.island.place(force: true) }
        }

        tick()
        // Read once: every read of a locked item is another Keychain prompt.
        let loaded = IdentityStore.load()
        switch loaded {
        case .success(let id?) where id.paired:
            usePaired(id)
        case .success:
            // Not connected yet: the island says so right away (an agent may have just installed the app).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.island.open(.pair, user: false) }
        case .failure(let e):
            // Never treat this as "not paired": the key may still work after a restart. The menu says
            // what is wrong. Pairing refuses a locked key (the old Mac would stay on the account).
            store.syncError = e.message
            if case .denied = e {
                // Said on the island too, with a way out: the menu bar icon alone is easy to miss.
                // Right after our own restart for this, the restart did not help either.
                let restarted = Date().timeIntervalSince1970 - UserDefaults.standard.double(forKey: Self.keyRestartKey) < 300
                island.keyLock = restarted ? .stuck : .locked
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.island.open(.pair, user: false) }
            }
        }
        if case .failure(.denied) = loaded {} else { UserDefaults.standard.removeObject(forKey: Self.keyRestartKey) }
    }

    private static let keyRestartKey = "pingme.keyRestartAt"

    /// Someone joined or connected a Mac since the last list: said once, as a quiet note on the island.
    private func contactsLoaded(_ contacts: [Contact]) {
        let news = ContactNews.diff(contacts, known: ContactNews.load())
        ContactNews.save(ContactNews.known(from: contacts))
        for n in news { store.notice(id: "news-\(n.userId)-\(n.kind.rawValue)-\(Int(Date().timeIntervalSince1970))", title: n.text) }
        if !news.isEmpty { tick() }
    }

    /// Replies to pings sent from the island: asked by id, only while some still wait for one.
    private func checkReplies() async {
        let watch = ReplyWatch.load()
        guard !watch.isEmpty, case .success(let rows) = await sync.sent(refs: Array(watch.keys)) else { return }
        let r = ReplyWatch.step(rows, watch: ReplyWatch.load(), now: Date().ms, open: sync.openReply)
        ReplyWatch.save(r.watch)
        for n in r.news { store.notice(id: "reply-\(n.ref)", title: n.text, from: "\(Fmt.firstName(n.name)) replied") }
        if !r.news.isEmpty { tick() }
    }

    /// "Try again" on the island: read the key once more; if macOS still refuses, restart pingme
    /// (after a rebuild only a fresh process gets the prompt). After that restart it is "stuck".
    private func retryKey() {
        switch IdentityStore.load() {
        case .success(let id?) where id.paired:
            UserDefaults.standard.removeObject(forKey: Self.keyRestartKey)
            usePaired(id)
            island.keyUnlocked()
        case .success:
            UserDefaults.standard.removeObject(forKey: Self.keyRestartKey)
            store.syncError = nil
            island.keyLock = nil
            updateStatusItem()
        case .failure(.denied):
            if island.keyLock == .locked { restart() }
        case .failure(let e):
            store.syncError = e.message
            island.keyLock = nil
            updateStatusItem()
        }
    }

    /// Quits and opens again a second later. A plain quit: launchd does not restart a clean exit.
    private func restart() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.keyRestartKey)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", Bundle.main.bundleURL.path]
        do { try p.run() } catch { return }
        NSApp.terminate(nil)
    }

    private func usePaired(_ id: DeviceIdentity) {
        sync.setIdentity(id)
        island.paired = sync.paired
        feed.use(token: sync.paired ? id.token : nil)
        store.syncError = nil
        sync.syncNow()
        updateStatusItem()
    }

    /// Unpaired here or on the server: forget the token and key, stop syncing, offer pairing again.
    private func forgetDevice(show: Bool) {
        sync.setIdentity(nil)
        feed.use(token: nil)
        try? IdentityStore.delete()
        ContactNews.forget()
        ReplyWatch.forget()
        island.paired = false
        store.syncError = nil
        updateStatusItem()
        if show { island.open(.pair, user: false) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        island.openFromUser()
        return false
    }

    /// pingme://people opens the people list (or pairing), pingme:// anything else opens the island.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, url.scheme == "pingme" else { return }
        if url.host == "people" { island.open(sync.paired ? .people : .pair, user: true) } else { island.openFromUser() }
    }

    private func tick() {
        if sync.paired, Date().timeIntervalSince(contactsCheckedAt) > 600 {
            contactsCheckedAt = Date()
            Task { _ = await sync.loadContacts() }
        }
        if sync.paired, !presence.quiet(at: Date()), Date().timeIntervalSince(repliesCheckedAt) > 120 {
            repliesCheckedAt = Date()
            Task { await checkReplies() }
        }
        _ = bridge.scan(into: store)
        triage.pump(store)
        island.tick()
        updateStatusItem()
    }

    /// The live feed changed: a ping arrived or left.
    private func feedValue(_ v: FeedValue) {
        let fresh = v.messages.filter { !store.acks.contains($0.ref) && !sync.recentlyConfirmed($0.ref) }
        guard !fresh.isEmpty else { return }
        // Store it right away (a red ping must pop within seconds), then ack it.
        if store.receive(sync.open(fresh)) { tick() }
        sync.syncNow()
    }

    /// Sync cadence: live feed first, keep-alive every 5 min (that is what keeps this Mac online),
    /// polling while the feed is down, nothing while asleep or locked for more than 5 minutes.
    private func schedule(now: Date = Date()) {
        guard sync.paired else { return }
        if !presence.asleep { feed.tick(now: now) }
        guard !presence.quiet(at: now) else { return }
        let since = now.timeIntervalSince(sync.lastAttempt)
        // Every sync is billed backend calls: keep-alive every 5 min (contacts see the Mac online
        // for 12), and while the live feed is down poll every 3 s for a minute, then every 30 s.
        let down = feed.downFor(at: now)
        if down >= 10, since >= (down < 70 ? 3 : 30) {
            sync.syncNow()
        } else if since >= 300 {
            sync.syncNow()
        } else if sync.lastFailed, !store.outbox.isEmpty, since >= 5 {
            sync.syncNow()
        }
    }

    private func updateStatusItem() {
        guard let button = statusItem.button else { return }
        let due = store.due().count
        let pending = store.pending.count
        let offline = store.syncError != nil
        let state = "\(due)/\(pending)/\(offline)"
        guard state != lastStatus else { return }
        lastStatus = state
        if offline && due == 0 {
            let image = NSImage(systemSymbolName: "icloud.slash", accessibilityDescription: "pingme offline")
            image?.isTemplate = true
            button.image = image
        } else {
            button.image = menuBarIcon(due: due > 0)
        }
        button.imagePosition = .imageLeading
        button.contentTintColor = due > 0 ? NSColor(hex: 0xFF6A13) : nil
        button.title = pending > 0 ? " \(pending)" : ""
        button.toolTip = due > 0 ? "pingme: \(due) waiting" : "pingme"
        button.setAccessibilityLabel(pending > 0 ? "pingme, \(Fmt.waitingLabel(pending))" : "pingme")
    }

    // MARK: Menu (open the island, quit)

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if let error = store.syncError {
            let item = NSMenuItem(title: error, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            menu.addItem(.separator())
        }
        menu.addItem(item("Open pingme", #selector(openIsland), key: ""))
        if sync.paired {
            menu.addItem(item("People", #selector(openPeople), key: ""))
        } else {
            menu.addItem(item("Connect this Mac", #selector(openPair), key: ""))
        }
        menu.addItem(.separator())
        if sync.paired { menu.addItem(item("Disconnect this Mac", #selector(unpair), key: "")) }
        menu.addItem(item("Quit pingme", #selector(quit), key: "q"))
    }

    private func item(_ title: String, _ selector: Selector, key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc private func openIsland() {
        // Let the menu close first, so the island can take the keyboard.
        DispatchQueue.main.async { [weak self] in self?.island.openFromUser() }
    }

    @objc private func openPeople() {
        DispatchQueue.main.async { [weak self] in self?.island.open(.people, user: true) }
    }

    @objc private func openPair() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.island.open(.pair, user: true)
            if !self.pairing.busy { self.pairing.start() }
        }
    }

    /// Revokes this Mac on the server and forgets its key. Asked first: it cannot be undone.
    @objc private func unpair() {
        let a = NSAlert()
        a.messageText = "Disconnect this Mac?"
        a.informativeText = "Pings will stop arriving here. You can connect it again."
        a.addButton(withTitle: "Disconnect")
        a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        Task {
            await sync.unpair()
            forgetDevice(show: false)
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    /// No windows, but the island's text fields still need copy and paste.
    private func installMainMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }
}
