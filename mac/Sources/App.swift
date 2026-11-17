// The app: a menu bar item and the island. No windows.

import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let store = TaskStore(fileURL: TaskStore.defaultURL())
    private var config: AppConfig!
    private var sync: SyncEngine!
    private var feed: LiveFeed!
    private var presence: Presence!
    private var island: IslandController!
    private var bridge: AgentBridge!
    private var triage: Triage!
    private var statusItem: NSStatusItem!
    private var tickTimer: Timer?
    private var lastStatus = ""
    private var lastWatching = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let me = NSRunningApplication.current
        if let bid = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: bid).contains(where: { $0 != me }) {
            exit(0)
        }
        guard let config = AppConfig.load() else {
            let a = NSAlert()
            a.messageText = "pingme chybí nastavení (config.json)."
            a.runModal()
            exit(1)
        }
        self.config = config
        installMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        presence = Presence()
        sync = SyncEngine(store: store, config: config)
        feed = LiveFeed(deploymentUrl: config.convexURL, key: config.token)
        sync.feedHealthy = { [weak self] in self?.feed.healthy ?? false }
        feed.onValue = { [weak self] value in self?.feedValue(value) }
        bridge = AgentBridge(dataDir: TaskStore.dataDir())
        bridge.onRecap = { [weak self] in self?.tick() }
        triage = Triage(dataDir: TaskStore.dataDir())
        triage.onFinish = { [weak self] in self?.tick() }
        island = IslandController(store: store, sync: sync, presence: presence, bridge: bridge)
        island.onChange = { [weak self] in
            self?.sync.noteLocalChange()
            self?.updateStatusItem()
        }
        sync.onSynced = { [weak self] in self?.tick() }
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

        feed.start()
        tick()
        sync.syncNow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        island.openFromUser()
        return false
    }

    /// pingme://people opens the people list, pingme:// anything else opens the island.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, url.scheme == "pingme" else { return }
        if url.host == "people" { island.open(.people, user: true) } else { island.openFromUser() }
    }

    private func tick() {
        _ = bridge.scan(into: store)
        triage.pump(store)
        island.tick()
        updateStatusItem()
    }

    /// The live feed changed: a command arrived or left, or the web pinged.
    private func feedValue(_ v: FeedValue) {
        sync.feedWebLastSeen = v.webLastSeen
        let fresh = v.commands.filter { !store.acks.contains($0.id) && !sync.recentlyConfirmed($0.id) }
        if !fresh.isEmpty {
            // Store it right away (a red task must pop within seconds), then confirm.
            if store.receive(fresh) { tick() }
            sync.syncNow()
        }
        checkWatching()
    }

    /// Sync cadence: live feed first, keep-alive every 60 s, 3 s polling while the feed is down,
    /// nothing while asleep or locked for more than 5 minutes.
    private func schedule(now: Date = Date()) {
        if !presence.asleep { feed.tick(now: now) }
        checkWatching()
        guard !presence.quiet(at: now) else { return }
        let since = now.timeIntervalSince(sync.lastAttempt)
        if feed.downFor(at: now) >= 10, since >= 3 {
            sync.syncNow()
        } else if since >= 60 {
            sync.syncNow()
        } else if sync.lastFailed, !store.outbox.isEmpty, since >= 5 {
            sync.syncNow()
        }
    }

    /// Someone opened the web: send the snapshot within a second.
    private func checkWatching() {
        let w = sync.watching
        if w && !lastWatching { sync.syncNow() }
        lastWatching = w
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
            let image = NSImage(systemSymbolName: "icloud.slash", accessibilityDescription: "pingme bez spojení")
            image?.isTemplate = true
            button.image = image
        } else {
            button.image = menuBarIcon(due: due > 0)
        }
        button.imagePosition = .imageLeading
        button.contentTintColor = due > 0 ? NSColor(hex: 0xFF6A13) : nil
        button.title = pending > 0 ? " \(pending)" : ""
        button.toolTip = due > 0 ? "pingme: něco čeká na odkliknutí (\(due))" : "pingme"
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
        menu.addItem(item("Otevřít pingme", #selector(openIsland), key: ""))
        menu.addItem(item("Lidé", #selector(openPeople), key: ""))
        menu.addItem(.separator())
        menu.addItem(item("Ukončit pingme", #selector(quit), key: "q"))
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

    @objc private func quit() { NSApp.terminate(nil) }

    /// No windows, but the island's text fields still need copy and paste.
    private func installMainMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Úpravy")
        edit.addItem(withTitle: "Zpět", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Vyjmout", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Kopírovat", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Vložit", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Vybrat vše", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }
}
