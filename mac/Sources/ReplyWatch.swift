// Replies to pings sent from the island or by an agent on this Mac pop up here too. This Mac keeps a
// small local list of the pings it sent and asks the server about only those (by id) until each has a
// reply or is gone. A ping for someone's agent may first get an automatic note from their Mac
// (`AutoAck`): it pops once, and the ping stays on the list until the person's own reply comes.

import Foundation

enum ReplyWatch {
    /// ref -> when it shows on their Mac (ms): now, or the time picked under Later.
    typealias Watch = [String: Double]

    struct News: Equatable {
        var ref: String
        var name: String
        var text: String
        /// The automatic note from their Mac, not the person's reply.
        var auto = false
    }

    /// ref -> replyAt of the automatic note already shown, so it pops once per ping. Its own file: the watch's
    /// shape stays as it is, a file that does not decode would drop every watched ping.
    typealias Shown = [String: Double]

    /// Stop asking this long after it showed: an undelivered ping is gone from the server after 7 days.
    static let maxAge: Double = 8 * 86_400_000

    /// One look at the server's rows for the watched refs. A reply becomes news and leaves the list;
    /// so does a ping that is done, gone, or too old. A reply that does not open here is dropped quietly.
    static func step(_ rows: [SentRow], watch: Watch, shown: Shown = [:], now: Double,
                     open: (SentRow) -> String?) -> (news: [News], watch: Watch, shown: Shown) {
        var left = watch
        var news: [News] = []
        let byRef = Dictionary(rows.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
        for (ref, sentAt) in watch {
            guard let row = byRef[ref] else {
                // Not in the answer: expired, or older than the server keeps.
                if now - sentAt > 60_000 { left[ref] = nil }
                continue
            }
            if row.replyAt != nil {
                let text = open(row)
                if let text, AutoAck.isAck(text, forAgent: row.forAgent) {
                    // Their Mac passed it on. The person's reply replaces this note later: keep asking.
                    if shown[ref] == nil, !AutoAck.strip(text).isEmpty {
                        news.append(News(ref: ref, name: row.toName, text: AutoAck.strip(text), auto: true))
                    }
                    if row.status == "done" || now - sentAt > maxAge { left[ref] = nil }
                    continue
                }
                left[ref] = nil
                if let text, !text.isEmpty { news.append(News(ref: ref, name: row.toName, text: text)) }
            } else if row.status == "done" || now - sentAt > maxAge {
                left[ref] = nil
            }
        }
        var seen = shown.filter { left[$0.key] != nil }
        for n in news where n.auto { seen[n.ref] = byRef[n.ref]?.replyAt }
        return (news.sorted { $0.ref < $1.ref }, left, seen)
    }

    @MainActor private static var file: URL { TaskStore.dataDir().appendingPathComponent("replies-watch.json") }
    @MainActor private static var shownFile: URL { TaskStore.dataDir().appendingPathComponent("replies-auto-shown.json") }

    @MainActor static func loadShown() -> Shown {
        guard let data = try? Data(contentsOf: shownFile) else { return [:] }
        return (try? JSONDecoder().decode(Shown.self, from: data)) ?? [:]
    }

    @MainActor static func saveShown(_ s: Shown) {
        if s.isEmpty { try? FileManager.default.removeItem(at: shownFile); return }
        if let data = try? JSONEncoder().encode(s) { try? data.write(to: shownFile, options: .atomic) }
    }

    @MainActor static func load() -> Watch {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode(Watch.self, from: data)) ?? [:]
    }

    @MainActor static func save(_ w: Watch) {
        if w.isEmpty { forget(); return }
        if let data = try? JSONEncoder().encode(w) { try? data.write(to: file, options: .atomic) }
    }

    @MainActor static func add(_ ref: String, at: Double = Date().ms) {
        var w = load()
        w[ref] = at
        // A handful at most in real use; the server answers 50 refs per call.
        if w.count > 50 { for k in w.sorted(by: { $0.value < $1.value }).prefix(w.count - 50).map(\.key) { w[k] = nil } }
        save(w)
    }

    @MainActor static func forget() {
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: shownFile)
    }
}
