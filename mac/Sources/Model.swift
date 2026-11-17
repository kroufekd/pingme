// Tasks, the local store and the outbox of statuses and replies.
// Tasks are stored only here, on the Mac. The server relays sealed pings, statuses and sealed replies.

import Foundation

let kSnoozeMinutes = 10
let kKeepDone: Double = 24 * 60 * 60 * 1000
let kTitleMax = 200
let kReplyMax = 200
let kNameMax = 60
let kReplyChips = ["Jdu na to", "Za chvíli", "Teď nemůžu"]

// MARK: - Config

/// Where the app talks to. No secrets here: the device token lives in the Keychain (Keychain.swift).
struct AppConfig: Codable {
    var api: String?
    var web: String?
    var convex: String?

    static let defaultAPI = "https://amiable-magpie-936.convex.site"
    static let defaultWeb = "https://pingme.macaly.app"
    static let defaultConvex = "https://amiable-magpie-936.convex.cloud"

    private static func pick(_ v: String?, _ fallback: String) -> String { (v?.isEmpty == false ? v : nil) ?? fallback }
    var apiURL: String { Self.pick(api, Self.defaultAPI) }
    var webURL: String { Self.pick(web, Self.defaultWeb) }
    var convexURL: String { Self.pick(convex, Self.defaultConvex) }

    /// config.json in the app bundle (build.sh writes it); the defaults when there is none (dev builds).
    static func load() -> AppConfig {
        guard let url = Bundle.main.url(forResource: "config", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let c = try? JSONDecoder().decode(AppConfig.self, from: data) else { return AppConfig() }
        return c
    }
}

extension Date {
    init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) }
    var ms: Double { (timeIntervalSince1970 * 1000).rounded() }
}

// MARK: - Urgency and senders

enum Urgency: String, Codable, CaseIterable, Comparable {
    case green, orange, red

    var word: String {
        switch self {
        case .green: return "Počká"
        case .orange: return "Brzy"
        case .red: return "Hned"
        }
    }

    private var rank: Int { self == .green ? 0 : self == .orange ? 1 : 2 }
    static func < (a: Urgency, b: Urgency) -> Bool { a.rank < b.rank }
}

enum SenderKind: String { case person, agent, owner }

// MARK: - Task

struct TodoTask: Codable, Identifiable, Equatable {
    var _id: String
    var title: String
    var dueAt: Double
    var createdAt: Double
    var source: String
    var createdByName: String
    var doneAt: Double?
    var snoozedUntil: Double?
    var snoozeCount: Int
    var followUpTitle: String?
    var followUpMinutes: Double?
    var followsFrom: String?
    var `repeat`: String? = nil
    // v2. Optional so files saved by v1 still load: missing means an owner task, green.
    var senderId: String? = nil
    var senderKind: String? = nil
    var urgency: String? = nil
    var taskRef: String? = nil
    var reply: String? = nil
    var replyAt: Double? = nil
    var seenAt: Double? = nil
    // Local only, never sent. Last delivery status sent for this occurrence (waiting, popped, snoozed).
    var stage: String? = nil
    // The owner clicked the island while this task was on it. Stops the reminders.
    var touchedAt: Double? = nil
    // Agent. `to == "agent"`: a sender wrote to Dominik's agent, the Mac triages it first.
    // `source == "agent"`: a Claude Code session on this Mac finished (local only, never shared).
    var to: String? = nil
    /// Claude Code session id: the finished session, or the triage run for a message to the agent.
    var agentSession: String? = nil
    /// The small model's short report on a message to the agent. Shown only on the island.
    var report: String? = nil
    /// running, done or failed.
    var triage: String? = nil
    // Network. The ping's sender and recipient, as the AAD of its reply needs them.
    var fromUserId: String? = nil
    var toUserId: String? = nil
    /// The agent that sent it ("Claude Code"), when an agent did.
    var fromAgent: String? = nil
    /// Legacy remote MCP: the reply goes back as plaintext.
    var plain: Bool? = nil
    /// The text could not be decrypted on this Mac; the title is a placeholder.
    var unreadable: Bool? = nil

    var id: String { _id }
    var showAt: Date { Date(ms: max(dueAt, snoozedUntil ?? 0)) }
    var dueDate: Date { Date(ms: dueAt) }
    var level: Urgency { Urgency(rawValue: urgency ?? "") ?? .green }
    var kind: SenderKind { SenderKind(rawValue: senderKind ?? "") ?? .owner }
    var canReply: Bool { taskRef != nil || isAgentSession }
    var isAgentSession: Bool { source == "agent" }
    var forAgent: Bool { to == "agent" }
    var triaging: Bool { triage == "running" }
    func isSnoozed(at now: Date) -> Bool { (snoozedUntil ?? 0) > now.ms }

    /// Who the task is from, as the island shows it.
    var fromName: String {
        switch kind {
        case .person, .agent: return createdByName
        case .owner:
            switch source {
            case "web": return createdByName
            case "followup": return "Další krok"
            case "agent": return createdByName
            default: return "Připomínka"
            }
        }
    }

    var followUp: (title: String, minutes: Int)? {
        guard let t = followUpTitle, !t.isEmpty, let m = followUpMinutes, m > 0 else { return nil }
        return (t, Int(m))
    }
}

// MARK: - Outbox

/// Decodes one element of an array without failing the whole array.
struct Lossy<T: Decodable>: Decodable {
    var value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// One status change or reply for a ping. Kept in a persisted outbox until the server takes it.
/// Statuses go with /device/sync; a reply is sealed only when it is sent (/device/reply), so the
/// plaintext waits here, on this Mac, like the task itself.
struct StatusEvent: Codable, Equatable {
    var uid: String
    var taskRef: String
    var status: String          // waiting, popped, seen, replied, done, snoozed
    var at: Double
    var snoozedUntil: Double?
    var reply: String?
    // The ping's sender and recipient (the reply's AAD), and whether it is a legacy plaintext ping.
    var from: String? = nil
    var to: String? = nil
    var plain: Bool? = nil

    var isReply: Bool { status == "replied" }

    /// What /device/sync takes.
    var wire: [String: Any] {
        var w: [String: Any] = ["ref": taskRef, "status": status, "at": at]
        if status == "snoozed", let s = snoozedUntil { w["snoozedUntil"] = s }
        return w
    }
}

// MARK: - Repeating tasks

enum Recurrence {
    static let all = ["daily", "weekdays", "weekly", "biweekly", "monthly"]

    /// Same words as the web form.
    static func label(_ rule: String) -> String? {
        switch rule {
        case "daily": return "Každý den"
        case "weekdays": return "Pracovní dny"
        case "weekly": return "Každý týden"
        case "biweekly": return "Po 14 dnech"
        case "monthly": return "Každý měsíc"
        default: return nil
        }
    }

    static func valid(_ rule: String?) -> String? { rule.flatMap { all.contains($0) ? $0 : nil } }

    /// The first time after `now` that follows the rule, counted from the original time (keeps the clock time).
    static func next(rule: String, from dueAt: Double, after now: Date, calendar: Calendar = .current) -> Double? {
        let start = Date(ms: dueAt)
        if rule == "monthly" {
            // Count whole months from the start, so the 31st does not drift to the 28th for good.
            for k in 1...600 {
                guard let d = calendar.date(byAdding: .month, value: k, to: start) else { return nil }
                if d > now { return d.ms }
            }
            return nil
        }
        func step(_ d: Date) -> Date? {
            switch rule {
            case "daily": return calendar.date(byAdding: .day, value: 1, to: d)
            case "weekly": return calendar.date(byAdding: .day, value: 7, to: d)
            case "biweekly": return calendar.date(byAdding: .day, value: 14, to: d)
            case "weekdays":
                var n = calendar.date(byAdding: .day, value: 1, to: d)
                while let x = n, calendar.isDateInWeekend(x) { n = calendar.date(byAdding: .day, value: 1, to: x) }
                return n
            default: return nil
            }
        }
        guard var d = step(start) else { return nil }
        var guardCount = 0
        while d <= now, guardCount < 2000, let n = step(d) { d = n; guardCount += 1 }
        return d.ms
    }
}

// MARK: - Store (the only place tasks live)

@MainActor
final class TaskStore: ObservableObject {
    @Published fileprivate(set) var pending: [TodoTask] = []
    @Published fileprivate(set) var done: [TodoTask] = []
    @Published var lastSync: Date?
    @Published var syncError: String?
    /// Server messages already stored here, to be confirmed on the next sync.
    fileprivate(set) var acks: [String] = []
    /// Status changes for senders, sent with the next sync and removed after a 200.
    fileprivate(set) var outbox: [StatusEvent] = []
    /// Recently applied server messages, so a repeated delivery does nothing.
    private var seen: [String] = []
    private var lastAt: Double = 0
    private let fileURL: URL?

    private struct Saved: Codable {
        var pending: [TodoTask]
        var done: [TodoTask]
        var acks: [String]
        var seen: [String]
        var outbox: [StatusEvent]?
    }

    init(fileURL: URL?) {
        self.fileURL = fileURL
        load()
    }

    /// For snapshots and tests: a store that never touches the disk.
    init(preview pending: [TodoTask]) {
        fileURL = nil
        self.pending = pending
    }

    static func defaultURL() -> URL {
        dataDir().appendingPathComponent("tasks.json")
    }

    /// ~/Library/Application Support/pingme: tasks, outbox and the Claude token.
    static func dataDir() -> URL {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("pingme", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func load() {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return }
        guard let saved = try? JSONDecoder().decode(Saved.self, from: data) else {
            // Never overwrite a file we cannot read. Keep a copy before the next save replaces it.
            let backup = url.deletingPathExtension().appendingPathExtension("unreadable-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.copyItem(at: url, to: backup)
            return
        }
        pending = saved.pending
        done = saved.done
        acks = saved.acks
        seen = saved.seen
        outbox = saved.outbox ?? []
    }

    private func persist() {
        guard let url = fileURL else { return }
        let saved = Saved(pending: pending, done: done, acks: acks, seen: seen, outbox: outbox)
        if let data = try? JSONEncoder().encode(saved) { try? data.write(to: url, options: .atomic) }
    }

    /// Sorts, forgets done tasks older than a day and saves to disk.
    private func commit() {
        pending.sort { $0.showAt < $1.showAt }
        let cutoff = Date().ms - kKeepDone
        done.removeAll { ($0.doneAt ?? 0) < cutoff }
        if done.count > 100 { done.removeLast(done.count - 100) }
        if outbox.count > 500 { outbox.removeFirst(outbox.count - 500) }
        persist()
    }

    func task(_ id: String) -> TodoTask? { pending.first { $0.id == id } }

    /// Due tasks, the most urgent first, then the oldest.
    func due(at now: Date = Date()) -> [TodoTask] {
        // A message for the agent waits for its triage report before it shows.
        pending.filter { $0.showAt <= now && !$0.triaging }.sorted {
            $0.level != $1.level ? $0.level > $1.level : $0.showAt < $1.showAt
        }
    }

    /// Scheduled and snoozed tasks, the soonest first.
    func waiting(at now: Date = Date()) -> [TodoTask] { pending.filter { $0.showAt > now } }

    // MARK: Statuses

    /// Status times only go up, so the server never drops a later change as older.
    private func stamp() -> Double {
        lastAt = max(Date().ms, lastAt + 1)
        return lastAt
    }

    private func emit(_ t: TodoTask, _ status: String, snoozedUntil: Double? = nil, reply: String? = nil) {
        guard let ref = t.taskRef else { return }
        outbox.append(StatusEvent(uid: UUID().uuidString, taskRef: ref, status: status, at: stamp(),
                                  snoozedUntil: snoozedUntil, reply: reply, from: t.fromUserId, to: t.toUserId,
                                  plain: t.plain))
    }

    private func update(_ id: String, _ change: (inout TodoTask) -> Void) -> TodoTask? {
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return nil }
        change(&pending[i])
        return pending[i]
    }

    /// The island grew with this task on it.
    func markPopped(_ id: String) {
        guard let t = update(id, { $0.stage = "popped" }) else { return }
        emit(t, "popped")
        commit()
    }

    /// The Mac has the task, but it is not on the island yet.
    func markWaiting(_ id: String) {
        guard let t = update(id, { $0.stage = "waiting" }) else { return }
        emit(t, "waiting")
        commit()
    }

    /// First hover, click or focus, or the island shown for a while on an active Mac.
    func markSeen(_ id: String) {
        guard let t = task(id), t.seenAt == nil else { return }
        let now = stamp()
        _ = update(id) { $0.seenAt = now }
        emit(t, "seen")
        commit()
    }

    /// The owner clicked the island while this task was on it.
    func touch(_ id: String) {
        guard let t = task(id) else { return }
        if t.touchedAt == nil { _ = update(id) { $0.touchedAt = Date().ms } }
        if t.seenAt == nil { markSeen(id) } else { commit() }
    }

    func reply(_ id: String, text: String) {
        let text = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(kReplyMax))
        guard !text.isEmpty else { return }
        let at = stamp()
        guard let t = update(id, {
            $0.reply = text
            $0.replyAt = at
            if $0.touchedAt == nil { $0.touchedAt = at }
            if $0.seenAt == nil { $0.seenAt = at }
        }) else { return }
        emit(t, "replied", reply: text)
        commit()
    }

    func markDone(_ id: String) {
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return }
        var t = pending.remove(at: i)
        let now = Date().ms
        t.doneAt = now
        done.insert(t, at: 0)
        emit(t, "done")
        if let f = t.followUp {
            pending.append(TodoTask(
                _id: UUID().uuidString, title: f.title, dueAt: now + Double(f.minutes) * 60_000, createdAt: now,
                source: "followup", createdByName: t.createdByName, doneAt: nil, snoozedUntil: nil, snoozeCount: 0,
                followUpTitle: nil, followUpMinutes: nil, followsFrom: t.title, urgency: t.urgency))
        }
        if let rule = t.repeat, let next = Recurrence.next(rule: rule, from: t.dueAt, after: Date()) {
            // The next occurrence keeps who sent it and its taskRef, under a new local id.
            let n = TodoTask(
                _id: UUID().uuidString, title: t.title, dueAt: next, createdAt: now,
                source: t.source, createdByName: t.createdByName, doneAt: nil, snoozedUntil: nil, snoozeCount: 0,
                followUpTitle: t.followUpTitle, followUpMinutes: t.followUpMinutes, followsFrom: nil, repeat: rule,
                senderId: t.senderId, senderKind: t.senderKind, urgency: t.urgency, taskRef: t.taskRef,
                stage: t.taskRef == nil ? nil : "waiting", fromUserId: t.fromUserId, toUserId: t.toUserId,
                fromAgent: t.fromAgent, plain: t.plain)
            pending.append(n)
            emit(n, "waiting")
        }
        commit()
    }

    func snooze(_ id: String, minutes: Int = kSnoozeMinutes) {
        let until = Date().ms + Double(minutes * 60_000)
        guard let t = update(id, {
            $0.snoozedUntil = until
            $0.snoozeCount += 1
            $0.stage = "snoozed"
            // When it comes back it pops, nags and gets seen again.
            $0.touchedAt = nil
            $0.seenAt = nil
        }) else { return }
        emit(t, "snoozed", snoozedUntil: until)
        commit()
    }

    func delete(_ id: String) { pending.removeAll { $0.id == id }; commit() }

    func add(title: String, dueAt: Date, urgency: Urgency, repeat rule: String?) {
        let title = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(kTitleMax))
        guard !title.isEmpty else { return }
        pending.append(TodoTask(
            _id: UUID().uuidString, title: title, dueAt: dueAt.ms, createdAt: Date().ms,
            source: "mac", createdByName: "Mac", doneAt: nil, snoozedUntil: nil, snoozeCount: 0,
            followUpTitle: nil, followUpMinutes: nil, followsFrom: nil,
            repeat: Recurrence.valid(rule), urgency: urgency.rawValue))
        commit()
    }

    /// Stores opened pings before they are acked. Returns true when something changed.
    /// A ping that does not open is stored and acked too: it will never become readable.
    func receive(_ pings: [IncomingPing]) -> Bool {
        guard !pings.isEmpty else { return false }
        var changed = false
        for p in pings {
            if !acks.contains(p.ref) { acks.append(p.ref) }
            guard !seen.contains(p.ref) else { continue }
            seen.append(p.ref)
            changed = true
            guard !pending.contains(where: { $0.id == p.ref || $0.taskRef == p.ref }) else { continue }
            pending.append(TodoTask(
                _id: p.ref, title: String(p.title.prefix(kTitleMax)), dueAt: p.dueAt, createdAt: p.createdAt,
                source: "web", createdByName: p.fromName, doneAt: nil, snoozedUntil: nil, snoozeCount: 0,
                followUpTitle: nil, followUpMinutes: nil, followsFrom: nil,
                repeat: Recurrence.valid(p.repeat),
                senderId: p.fromUserId, senderKind: p.fromAgent == nil ? "person" : "agent",
                urgency: (Urgency(rawValue: p.urgency) ?? .green).rawValue,
                taskRef: p.ref,
                to: p.forAgent ? "agent" : nil,
                // Nothing to triage in a placeholder.
                triage: p.forAgent && !p.unreadable ? "running" : nil,
                fromUserId: p.fromUserId, toUserId: p.toUserId, fromAgent: p.fromAgent,
                plain: p.plain ? true : nil, unreadable: p.unreadable ? true : nil))
        }
        if seen.count > 500 { seen.removeFirst(seen.count - 500) }
        commit()
        return changed
    }

    /// The server took these acks, no need to send them again.
    func confirmed(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        acks.removeAll { ids.contains($0) }
        persist()
    }

    /// The server stored these statuses.
    func delivered(_ uids: Set<String>) {
        guard !uids.isEmpty else { return }
        outbox.removeAll { uids.contains($0.uid) }
        persist()
    }

    // MARK: Agent

    /// A Claude Code session finished. One item per session: a later finish replaces the text and pops again.
    /// A session finished. It waits up to `hold` seconds for its name and recap (`finishAgentSession`).
    func upsertAgentSession(session: String, project: String, text: String, hold: TimeInterval = 0) {
        let id = "agent-\(session)"
        let now = Date().ms + hold * 1000
        if update(id, {
            $0.title = text
            $0.dueAt = now
            $0.snoozedUntil = nil
            $0.seenAt = nil
            $0.touchedAt = nil
            $0.reply = nil
            $0.replyAt = nil
        }) == nil {
            pending.append(TodoTask(
                _id: id, title: text, dueAt: now, createdAt: now, source: "agent", createdByName: project,
                doneAt: nil, snoozedUntil: nil, snoozeCount: 0, followUpTitle: nil, followUpMinutes: nil,
                followsFrom: nil, agentSession: session))
        }
        commit()
    }

    /// The session's name and recap are here: show it now. A newer finish of the same session wins.
    func finishAgentSession(session: String, name: String, text: String?, ifStill quick: String) {
        let id = "agent-\(session)"
        guard pending.first(where: { $0.id == id })?.title == quick else { return }
        _ = update(id) {
            $0.createdByName = name
            if let text { $0.title = text }
            $0.dueAt = min($0.dueAt, Date().ms)
        }
        commit()
    }

    /// The small model finished reading a message for the agent. Only now it shows on the island.
    func finishTriage(_ id: String, report: String, session: String?, failed: Bool) {
        _ = update(id) {
            $0.triage = failed ? "failed" : "done"
            $0.report = report
            if let session { $0.agentSession = session }
        }
        commit()
    }
}
