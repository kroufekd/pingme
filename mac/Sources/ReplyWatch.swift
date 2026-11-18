// Replies to pings sent from the island pop up here too. This Mac keeps a small local list of the
// pings it sent and asks the server about only those (by id) until each has a reply or is gone.
// Pings sent by an agent are not on it: the agent reads its replies itself with reply(id).

import Foundation

enum ReplyWatch {
    /// ref -> when it was sent (ms).
    typealias Watch = [String: Double]

    struct News: Equatable {
        var ref: String
        var name: String
        var text: String
    }

    /// Stop asking after this: the ping itself is gone from the server by then.
    static let maxAge: Double = 8 * 86_400_000

    /// One look at the server's rows for the watched refs. A reply becomes news and leaves the list;
    /// so does a ping that is done, gone, or too old. A reply that does not open here is dropped quietly.
    static func step(_ rows: [SentRow], watch: Watch, now: Double, open: (SentRow) -> String?) -> (news: [News], watch: Watch) {
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
                left[ref] = nil
                if let text = open(row), !text.isEmpty { news.append(News(ref: ref, name: row.toName, text: text)) }
            } else if row.status == "done" || now - sentAt > maxAge {
                left[ref] = nil
            }
        }
        return (news.sorted { $0.ref < $1.ref }, left)
    }

    @MainActor private static var file: URL { TaskStore.dataDir().appendingPathComponent("replies-watch.json") }

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

    @MainActor static func forget() { try? FileManager.default.removeItem(at: file) }
}
