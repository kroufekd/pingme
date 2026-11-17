// Headless pictures of the island states with made-up data, for checking the look without installing.
// One state per frame of design/v2/e-mac-minimal.html, same names and the same desktop slice.
// Never builds the real store, the sync engine or the live feed.

import AppKit
import SwiftUI

enum SnapshotState: String, CaseIterable {
    case idle, idleHover = "idle-hover", idleWaiting = "idle-waiting", idleWaitingHover = "idle-waiting-hover"
    case taskGreen = "task-green", taskOrange = "task-orange", taskRed = "task-red", taskAgent = "task-agent"
    case taskHover = "task-hover"
    case replyOpen = "reply-open", replyTyping = "reply-typing", replySent = "reply-sent"
    case newEmpty = "new-empty", new, newLater = "new-later"
    case waiting, waitingHover = "waiting-hover"
    case people, peopleHover = "people-hover", peopleAdd = "people-add"
    // Extra checks, not frames of the design.
    case taskOwnerHover = "task-owner-hover"
    case agentDone = "agent-done", agentReply = "agent-reply", agentTriage = "agent-triage"
    // The network (phase 2).
    case peopleDetail = "people-detail", peopleInvited = "people-invited", peopleEmpty = "people-empty"
    case pair, pairing, pairFailed = "pair-failed", pairDone = "pair-done"
    case taskUnreadable = "task-unreadable", taskPlain = "task-plain"

    /// Height of the desktop slice, as in the design (`--h`).
    var deskHeight: CGFloat {
        switch self {
        case .idle, .idleHover, .idleWaiting, .idleWaitingHover: return 120
        case .replyOpen, .replyTyping, .replySent, .newLater: return 210
        case .waiting, .waitingHover: return 230
        case .people, .peopleHover, .peopleAdd, .peopleInvited: return 260
        case .peopleDetail: return 320
        case .peopleEmpty, .pair, .pairing, .pairFailed, .pairDone: return 150
        case .agentTriage: return 270
        case .agentDone, .agentReply: return 210
        default: return 180
        }
    }

    var menuLeft: [String] {
        switch self {
        case .idle, .idleHover, .idleWaiting: return ["Safari", "File"]
        default: return ["Safari"]
        }
    }

    var menuRight: [String] {
        switch self {
        case .idle, .idleHover, .idleWaiting, .idleWaitingHover: return ["Mon 16 Nov", "14:04"]
        default: return ["14:04"]
        }
    }
}

/// Monday 16 Nov 2026, 14:04, like the design's menu bar.
private let snapshotNow: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 11; c.day = 16; c.hour = 14; c.minute = 4
    return Calendar.current.date(from: c) ?? Date()
}()

@MainActor
private func sample(_ title: String, from name: String, kind: SenderKind, urgency: Urgency,
                    showAt: Date, repeat rule: String? = nil, snoozedUntil: Date? = nil) -> TodoTask {
    let sender = kind != .owner
    return TodoTask(
        _id: UUID().uuidString, title: title, dueAt: (snoozedUntil == nil ? showAt : showAt.addingTimeInterval(-3600)).ms,
        createdAt: showAt.ms, source: sender ? "web" : "mac", createdByName: sender ? name : "Mac", doneAt: nil,
        snoozedUntil: snoozedUntil?.ms, snoozeCount: snoozedUntil == nil ? 0 : 1, followUpTitle: nil,
        followUpMinutes: nil, followsFrom: nil, repeat: rule,
        senderId: sender ? "s-\(name)" : nil, senderKind: sender ? kind.rawValue : nil,
        urgency: urgency.rawValue, taskRef: sender ? UUID().uuidString : nil)
}

@MainActor
private func fill(_ model: IslandModel, state: SnapshotState, now: Date) {
    let cal = Calendar.current
    func at(days: Int, _ h: Int, _ m: Int) -> Date {
        let d = cal.date(byAdding: .day, value: days, to: now) ?? now
        return cal.date(bySettingHour: h, minute: m, second: 0, of: d) ?? d
    }
    let viki = sample("Take the laundry out of the washer", from: "Viki", kind: .person, urgency: .red, showAt: now.addingTimeInterval(-130))
    model.waitingCount = 4
    switch state {
    case .idle, .idleHover, .idleWaiting, .idleWaitingHover:
        model.mode = .closed
        model.shown = .compose
        model.earsCount = [.idleWaiting, .idleWaitingHover].contains(state) ? 2 : 0
        model.earsUrgency = .orange
        model.peek = [.idleHover, .idleWaitingHover].contains(state)
    case .agentDone, .agentReply:
        var t = sample("PR #482 is done and the preview is building. Sign in on the panel with Google, then I'll run QA.", from: "macaly",
                       kind: .owner, urgency: .green, showAt: now)
        t.source = "agent"
        t.createdByName = "macaly pricing · waiting on deploy"
        t.agentSession = "7b9a3941-d23d-4ec7-8725-69c0fd75f5a2"
        model.mode = .task
        model.shown = .task
        model.hover = true
        if state == .agentReply {
            model.replyOpen = true
            model.replyText = "Great, run the Mac app too"
            model.stillFocus = "reply"
        }
        model.current = t
    case .agentTriage:
        var t = sample("The invite link gives me an error, can you take a look?", from: "Viki", kind: .person,
                       urgency: .orange, showAt: now)
        t.to = "agent"
        t.triage = "done"
        t.agentSession = "0a5b9c11-093d-43e7-8a6a-569fe6cc8ba8"
        t.report = "What: Viki can't open an invite, she didn't send the error text.\nWhere: probably v2/convex/inviteLinks.ts, check and start return bad-link.\nEffort: small.\nAdvice: ask Viki for the exact error text."
        model.mode = .task
        model.shown = .task
        model.hover = true
        model.current = t
    case .taskGreen, .taskOrange, .taskRed, .taskAgent, .taskHover, .replyOpen, .replyTyping, .replySent, .taskOwnerHover,
         .taskUnreadable, .taskPlain:
        var t: TodoTask
        switch state {
        case .taskGreen: t = sample("Call me when you have a minute", from: "Mom", kind: .person, urgency: .green, showAt: now)
        case .taskOrange: t = sample("Send me the photos from the mountains", from: "Franta", kind: .person, urgency: .orange, showAt: now)
        case .taskAgent:
            t = sample("The invites PR is done, take a look at the preview", from: "Michal", kind: .agent,
                       urgency: .green, showAt: now.addingTimeInterval(-70))
            t.fromAgent = "Claude Code"
            t.fromUserId = "u-michal"
        case .taskUnreadable:
            t = sample(Net.unreadableTitle, from: "Viki", kind: .person, urgency: .orange, showAt: now)
            t.unreadable = true
        case .taskPlain:
            // Legacy remote MCP, with a long name: the marker must stay visible.
            t = sample("Check the build, tests are failing", from: "Claude Code - macaly-web, invites branch",
                       kind: .agent, urgency: .orange, showAt: now)
            t.fromAgent = "mcp"
            t.plain = true
        case .taskOwnerHover: t = sample("Water the plants", from: "", kind: .owner, urgency: .orange, showAt: now, repeat: "weekly")
        default: t = viki
        }
        model.mode = .task
        model.shown = .task
        model.hover = state == .taskHover || state == .taskOwnerHover
        if state == .replyOpen || state == .replyTyping { model.replyOpen = true }
        if state == .replyTyping {
            model.replyText = "Back in 5 minutes, finishing an email"
            model.stillFocus = "reply"
        }
        if state == .replySent {
            t.reply = "Back in 5 minutes, finishing an email"
            t.touchedAt = now.ms
            model.sentNote = "Back in 5 minutes, finishing an email"
        }
        model.current = t
    case .newEmpty, .new, .newLater:
        model.mode = .compose
        model.shown = .compose
        model.newTitle = state == .newEmpty ? "" : "Call the plumber"
        model.newUrgency = state == .newLater ? .orange : .green
        model.later = state == .newLater
        model.laterDate = at(days: 1, 9, 30)
        model.laterRepeat = state == .newLater ? "weekdays" : ""
        if state == .new { model.stillFocus = "title" }
    case .waiting, .waitingHover:
        model.mode = .waiting
        model.shown = .waiting
        let first = sample("Pick up the keys", from: "Viki", kind: .person, urgency: .red,
                           showAt: now.addingTimeInterval(480), snoozedUntil: now.addingTimeInterval(480))
        model.waitingRows = [
            first,
            sample("Call the plumber", from: "", kind: .owner, urgency: .orange, showAt: at(days: 1, 9, 30)),
            sample("Give me my drill back", from: "Franta", kind: .person, urgency: .green, showAt: at(days: 2, 18, 0)),
            sample("Water the plants", from: "", kind: .owner, urgency: .green, showAt: at(days: 5, 10, 0), repeat: "weekly"),
        ]
        if state == .waitingHover { model.hoverRow = first.id }
    case .people, .peopleHover, .peopleAdd, .peopleDetail, .peopleInvited, .peopleEmpty:
        model.mode = .people
        model.shown = .people
        model.peopleLoad = .loaded
        // Made-up keys: fingerprints come out the same on every run.
        func key(_ b: UInt8) -> String { Data(repeating: b, count: 32).base64EncodedString() }
        func row(_ id: String, _ name: String, mac: Bool, seen: TimeInterval?, keys: [(String, UInt8)]) -> ContactRow {
            ContactRow(id: id, name: name, hasMac: mac, lastSeen: seen.map { now.addingTimeInterval(-$0) },
                       keys: keys.compactMap { k in Net.fingerprint(key(k.1)).map { ContactRow.Key(kind: k.0, fingerprint: $0) } })
        }
        if state != .peopleEmpty {
            model.contacts = [
                row("1", "Michal", mac: true, seen: 40, keys: [("Mac", 1), ("Web", 2)]),
                row("2", "Franta", mac: true, seen: 3 * 3600, keys: [("Mac", 3)]),
                row("3", "Viki", mac: false, seen: nil, keys: [("Web", 4)]),
            ]
            model.invites = [Invite(inviteId: "i1", name: "Kuba", email: nil, expiresAt: now.addingTimeInterval(7 * 86400).ms)]
        }
        model.myKey = Net.fingerprint(key(9))
        if state == .peopleHover { model.hoverRow = "2" }
        if state == .peopleDetail {
            model.openContact = "1"
            model.hoverRow = "1"
        }
        if state == .peopleAdd {
            model.personName = "Mom"
            model.stillFocus = "name"
        }
        if state == .peopleInvited {
            model.said = "Link copied, good for 7 days."
            model.saidOK = true
        }
    case .pair, .pairing, .pairFailed, .pairDone:
        model.mode = .pair
        model.shown = .pair
        switch state {
        case .pairing: model.pair = .waiting("309365")
        case .pairFailed: model.pair = .failed("Expired, try again.")
        case .pairDone: model.pair = .done("Michal")
        default: model.pair = .idle
        }
    }
}

/// The design's desktop slice: cream gradient, a translucent menu bar, the island on top.
private struct SnapshotDesktop: View {
    @ObservedObject var model: IslandModel
    let state: SnapshotState
    let width: CGFloat
    var still = false

    var body: some View {
        let m = model.metrics
        let bar: CGFloat = 32
        ZStack(alignment: .top) {
            ZStack {
                LinearGradient(colors: [Color(hex: 0xF1E6D2), Color(hex: 0xEEE7D6)],
                               startPoint: UnitPoint(x: 0.33, y: 0), endPoint: UnitPoint(x: 0.67, y: 1))
                EllipticalGradient(colors: [Color(hex: 0xF6D9B8), Color(hex: 0xF6D9B8, opacity: 0)],
                                   center: UnitPoint(x: 0.08, y: 1.1), startRadiusFraction: 0, endRadiusFraction: 0.66)
                EllipticalGradient(colors: [Color(hex: 0xCFE6D2), Color(hex: 0xCFE6D2, opacity: 0)],
                                   center: UnitPoint(x: 0.96, y: 0.96), startRadiusFraction: 0, endRadiusFraction: 0.5)
            }
            HStack(spacing: 0) {
                ForEach(Array(state.menuLeft.enumerated()), id: \.offset) { i, s in
                    Text(s).font(Geist.font(12.5, i == 0 ? 600 : 500)).padding(.leading, i == 0 ? 0 : 12)
                }
                Spacer()
                ForEach(Array(state.menuRight.enumerated()), id: \.offset) { i, s in
                    Text(s).font(Geist.font(12.5, 500)).padding(.leading, i == 0 ? 0 : 12)
                }
            }
            .foregroundStyle(Color(hex: 0x1B1A17))
            .padding(.horizontal, 12)
            .frame(height: bar)
            .background(Color(hex: 0xFAF5E8, opacity: 0.55))
            IslandView(model: model, actions: IslandActions())
                .padding(.top, m.hasNotch ? 0 : bar)
        }
        .frame(width: width, height: state.deskHeight, alignment: .top)
        .clipped()
        .environment(\.islandStill, still)
    }
}

@MainActor
/// Default: SwiftUI ImageRenderer at 2x with stand-ins for AppKit controls. `appKit`: the real controls
/// through NSView caching, at 1x. `real`: this Mac's own notch size instead of the design's.
func renderSnapshot(state: SnapshotState, to path: String, fake: Bool, appKit: Bool, real: Bool = false) -> Bool {
    _ = NSApplication.shared
    NSApp.appearance = NSAppearance(named: .darkAqua)
    Geist.register()
    let model = IslandModel()
    if real, let s = NSScreen.builtIn ?? NSScreen.main {
        model.metrics = IslandMetrics.forScreen(s)
    } else {
        model.metrics = fake ? .fake : .demo
    }
    model.now = snapshotNow
    fill(model, state: state, now: model.now)

    let width: CGFloat = 560
    let hosting = NSHostingView(rootView: SnapshotDesktop(model: model, state: state, width: width, still: !appKit))
    hosting.frame = NSRect(x: 0, y: 0, width: width, height: state.deskHeight)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = hosting
    // Let the island measure itself and settle.
    RunLoop.main.run(until: Date().addingTimeInterval(1.0))
    hosting.layoutSubtreeIfNeeded()
    if !appKit {
        // SwiftUI's own renderer draws the shapes exactly; text fields and menus are stand-ins.
        let r = ImageRenderer(content: SnapshotDesktop(model: model, state: state, width: width, still: true))
        r.scale = 2
        guard let cg = r.cgImage, let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }
    guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return false }
    hosting.cacheDisplay(in: hosting.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { return false }
    return (try? png.write(to: URL(fileURLWithPath: path))) != nil
}
