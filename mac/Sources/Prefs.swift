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

    /// 8:00 tomorrow, local time.
    static func tomorrowMorning(after now: Date = Date()) -> Date {
        let cal = Calendar.current
        let tomorrow = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? now.addingTimeInterval(86_400)
        return cal.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
}
