// Settings that stay on this Mac (UserDefaults). Nothing here goes to the server: senders never learn
// that pings are paused or hidden; their pings simply wait on this Mac as "not shown yet".

import Foundation

enum Prefs {
    private static let pausedKey = "pingme.pausedUntil"
    private static let hideKey = "pingme.hideText"

    /// Until when new pings stay quiet. Nil: not paused. An expired pause clears itself.
    static var pausedUntil: Date? {
        get {
            let t = UserDefaults.standard.double(forKey: pausedKey)
            guard t > 0 else { return nil }
            let d = Date(timeIntervalSince1970: t)
            if d <= Date() { UserDefaults.standard.removeObject(forKey: pausedKey); return nil }
            return d
        }
        set {
            if let d = newValue { UserDefaults.standard.set(d.timeIntervalSince1970, forKey: pausedKey) }
            else { UserDefaults.standard.removeObject(forKey: pausedKey) }
        }
    }

    static func paused(at now: Date = Date()) -> Bool { (pausedUntil.map { $0 > now }) ?? false }

    /// Ping text shows only while the pointer is on the island (screen sharing, people around).
    static var hideText: Bool {
        get { UserDefaults.standard.bool(forKey: hideKey) }
        set { UserDefaults.standard.set(newValue, forKey: hideKey) }
    }

    private static let noAckKey = "pingme.noAutoAck"

    /// A ping for the agent gets a short automatic "passed it on" reply (`AutoAck`). On unless turned off.
    static var autoAck: Bool {
        get { !UserDefaults.standard.bool(forKey: noAckKey) }
        set { UserDefaults.standard.set(!newValue, forKey: noAckKey) }
    }

    /// 8:00 tomorrow, local time.
    static func tomorrowMorning(after now: Date = Date()) -> Date {
        let cal = Calendar.current
        let tomorrow = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? now.addingTimeInterval(86_400)
        return cal.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
}

/// Which due pings arrive (pop) now and which count as already known, with or without a pause.
enum Arrivals {
    struct Item: Equatable {
        var id: String
        var red: Bool
        /// The owner already acted on it (opened, replied, Esc).
        var touched: Bool
    }

    /// Paused: every due ping but red that the owner has not touched or put away (Esc) is held:
    /// not known, so it arrives when the pause ends. That includes one on the island when the pause
    /// starts. Red arrives as always.
    static func split(_ due: [Item], known: Set<String>, dismissed: Set<String>, paused: Bool)
        -> (fresh: Set<String>, known: Set<String>) {
        let ids = Set(due.map(\.id))
        let held = paused ? Set(due.filter { !$0.red && !$0.touched && !dismissed.contains($0.id) }.map(\.id)) : []
        return (ids.subtracting(known).subtracting(held), ids.subtracting(held))
    }
}
