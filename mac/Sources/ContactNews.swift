// "Michal joined pingme", "Michal can get pings now": this Mac remembers who it has seen, and whether
// with a Mac, in a small local file. The server keeps no "seen" state; the same contact list it already
// serves is compared here.

import Foundation

enum ContactNews {
    struct News: Equatable {
        enum Kind: String { case joined, mac }
        var userId: String
        var name: String
        var kind: Kind

        var text: String { kind == .joined ? "\(name) joined pingme." : "\(name) can get pings now." }
    }

    /// userId -> had a Mac when last seen. Nil until the list has been learned once.
    typealias Known = [String: Bool]

    /// What changed since `known`. The first list is only learned: nothing in it is news.
    static func diff(_ contacts: [Contact], known: Known?) -> [News] {
        guard let known else { return [] }
        var news: [News] = []
        for c in contacts {
            switch known[c.userId] {
            case nil: news.append(News(userId: c.userId, name: c.name, kind: .joined))
            case false? where c.hasMac: news.append(News(userId: c.userId, name: c.name, kind: .mac))
            default: break
            }
        }
        return news
    }

    static func known(from contacts: [Contact]) -> Known {
        Dictionary(contacts.map { ($0.userId, $0.hasMac) }, uniquingKeysWith: { a, _ in a })
    }

    @MainActor private static var file: URL { TaskStore.dataDir().appendingPathComponent("contacts-known.json") }

    @MainActor static func load() -> Known? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Known.self, from: data)
    }

    @MainActor static func save(_ known: Known) {
        if let data = try? JSONEncoder().encode(known) { try? data.write(to: file, options: .atomic) }
    }

    /// Unpaired: the next account starts by learning its own list.
    @MainActor static func forget() { try? FileManager.default.removeItem(at: file) }
}
