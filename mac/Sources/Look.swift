// Colors, type, icons and Czech formatting. Island tokens follow the v2 design (variant D).

import AppKit
import SwiftUI

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// Island palette, same tokens as the design (`--island`, `--on-island`, urgency pastels).
enum Ink {
    static let island = Color.black
    static let island2 = Color(hex: 0x1C1C1E)
    static let island3 = Color(hex: 0x2C2C2E)
    static let on = Color(hex: 0xF6F2E8)
    static let on2 = Color(hex: 0xB4B0A6)
    static let on3 = Color(hex: 0x8F8B82)
    static let edge = Color(hex: 0x77736A)
    static let placeholder = Color(hex: 0xA6A298)
    static let hair = Color(hex: 0x2A2A2C)
    static let nsOn = NSColor(hex: 0xF6F2E8)

    static func urgency(_ u: Urgency) -> Color {
        switch u {
        case .green: return Color(hex: 0xBFE6C4)
        case .orange: return Color(hex: 0xFFD6A3)
        case .red: return Color(hex: 0xFFBBB2)
        }
    }
}

extension NSScreen {
    /// The MacBook's own display. Nil when the lid is closed.
    static var builtIn: NSScreen? {
        screens.first { s in
            guard let id = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return false }
            return CGDisplayIsBuiltin(id) != 0
        }
    }
}

// MARK: - Type (Geist, shipped in Resources/fonts, OFL)

enum Geist {
    private static var registered = false
    private static var available = false
    private static let dev = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Resources/fonts")
    private static let files = ["GeistIsland-W400", "GeistIsland-W500", "GeistIsland-W550", "GeistIsland-W600", "GeistIslandMono"]

    /// Registers the bundled fonts for this process. Without them the system font stands in.
    static func register() {
        guard !registered else { return }
        registered = true
        let dirs = [Bundle.main.resourceURL?.appendingPathComponent("fonts"), dev].compactMap { $0 }
        guard let dir = dirs.first(where: { FileManager.default.fileExists(atPath: $0.appendingPathComponent("\(files[0]).ttf").path) })
        else { return }
        var ok = true
        for f in files {
            let url = dir.appendingPathComponent("\(f).ttf") as CFURL
            if !CTFontManagerRegisterFontsForURL(url, .process, nil), NSFont(name: f, size: 12) == nil { ok = false }
        }
        available = ok
    }

    /// Weights the design uses: 400, 500, 550, 600.
    static func font(_ size: CGFloat, _ weight: Int = 400) -> Font {
        register()
        let w = weight >= 600 ? 600 : weight >= 550 ? 550 : weight >= 500 ? 500 : 400
        guard available else {
            let sys: Font.Weight = w >= 600 ? .semibold : w >= 500 ? .medium : .regular
            return .system(size: size, weight: sys)
        }
        return .custom("GeistIsland-W\(w)", fixedSize: size)
    }

    static func mono(_ size: CGFloat) -> Font {
        register()
        return available ? .custom("GeistIslandMono", fixedSize: size) : .system(size: size, design: .monospaced)
    }

    static func nsFont(_ size: CGFloat, _ weight: Int = 400) -> NSFont {
        register()
        let w = weight >= 600 ? 600 : weight >= 550 ? 550 : weight >= 500 ? 500 : 400
        return NSFont(name: "GeistIsland-W\(w)", size: size) ?? .systemFont(ofSize: size, weight: w >= 600 ? .semibold : w >= 500 ? .medium : .regular)
    }
}

// MARK: - Icons (the design's SVG files, shipped in Resources/icons)

enum Icons {
    private static var cache: [String: NSImage] = [:]
    private static let dev = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Resources/icons")

    static func image(_ name: String) -> NSImage? {
        if let i = cache[name] { return i }
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("icons/\(name).svg")
        let url = [bundled, dev.appendingPathComponent("\(name).svg")]
            .compactMap { $0 }
            .first { FileManager.default.fileExists(atPath: $0.path) }
        guard let url, let img = NSImage(contentsOf: url) else { return nil }
        img.isTemplate = true
        cache[name] = img
        return img
    }
}

/// One of the design's line icons, tinted like text.
struct Icon: View {
    let name: String
    var size: CGFloat = 18
    var color: Color = Ink.on

    var body: some View {
        Group {
            if let img = Icons.image(name) {
                Image(nsImage: img).renderingMode(.template).resizable().interpolation(.high)
            } else {
                Color.clear
            }
        }
        .foregroundStyle(color)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Czech formatting

enum Fmt {
    static func clock(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "teď", "před 2 min", "před 3 h", "včera", "před 4 dny"
    static func ago(_ d: Date, now: Date = Date()) -> String {
        let s = now.timeIntervalSince(d)
        if s < 60 { return "teď" }
        let m = Int(s / 60)
        if m < 60 { return "před \(m) min" }
        let h = m / 60
        if h < 24 { return "před \(h) h" }
        let days = h / 24
        return days == 1 ? "včera" : "před \(days) dny"
    }

    private static let shortDays = ["ne", "po", "út", "st", "čt", "pá", "so"]

    /// "14:12", "zítra 9:30", "út 18:00", "24. 11. 9:30"
    static func when(_ d: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: d)).day ?? 0
        switch days {
        case ...0: return clock(d)
        case 1: return "zítra \(clock(d))"
        case 2...6: return "\(shortDays[cal.component(.weekday, from: d) - 1]) \(clock(d))"
        default:
            let c = cal.dateComponents([.day, .month], from: d)
            return "\(c.day ?? 0). \(c.month ?? 0). \(clock(d))"
        }
    }

    /// "23. 11."
    static func day(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.day, .month], from: d)
        return "\(c.day ?? 0). \(c.month ?? 0)."
    }

    static func tasks(_ n: Int) -> String {
        switch n {
        case 1: return "1 úkol"
        case 2...4: return "\(n) úkoly"
        default: return "\(n) úkolů"
        }
    }

    /// Short form next to the notch: "1 čeká", "2 čekají", "5 čeká".
    static func waitingShort(_ n: Int) -> String {
        (2...4).contains(n) ? "\(n) čekají" : "\(n) čeká"
    }

    /// "dnes, po 16. 11.", "zítra, út 17. 11.", "st 18. 11."
    static func dayLabel(_ d: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: d)).day ?? 0
        let base = "\(shortDays[cal.component(.weekday, from: d) - 1]) \(day(d))"
        switch days {
        case 0: return "dnes, \(base)"
        case 1: return "zítra, \(base)"
        default: return base
        }
    }

    static func waitingLabel(_ n: Int) -> String {
        switch n {
        case 1: return "1 úkol čeká"
        case 2...4: return "\(n) úkoly čekají"
        default: return "\(n) úkolů čeká"
        }
    }
}

// MARK: - Icons

/// App icon: the lavender note with a tick, held by the magnet. Same drawing as the web favicon (64 unit grid).
func renderIcon(size: Int, fullBleed: Bool) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    let s = CGFloat(size)
    let body = fullBleed ? NSRect(x: 0, y: 0, width: s, height: s) : NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
    let shape = fullBleed ? NSBezierPath(rect: body)
        : NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
    NSGradient(starting: NSColor(hex: 0x0F0F10), ending: NSColor(hex: 0x232326))?.draw(in: shape, angle: 90)

    let u = body.width / 64
    // SVG coordinates (y down) to the bitmap (y up).
    func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: body.minX + x * u, y: body.minY + (64 - y) * u)
    }
    func shadow(_ alpha: CGFloat, blur: CGFloat, drop: CGFloat) {
        let sh = NSShadow()
        sh.shadowColor = NSColor.black.withAlphaComponent(alpha)
        sh.shadowBlurRadius = blur * u
        sh.shadowOffset = NSSize(width: 0, height: -drop * u)
        sh.set()
    }

    // The note, tilted a little.
    NSGraphicsContext.saveGraphicsState()
    let pivot = pt(32, 35)
    let tilt = NSAffineTransform()
    tilt.translateX(by: pivot.x, yBy: pivot.y)
    tilt.rotate(byDegrees: 6)
    tilt.translateX(by: -pivot.x, yBy: -pivot.y)
    tilt.concat()
    let corner = pt(13, 54)
    let note = NSBezierPath(roundedRect: NSRect(x: corner.x, y: corner.y, width: 38 * u, height: 38 * u), xRadius: 3.5 * u, yRadius: 3.5 * u)
    NSGraphicsContext.saveGraphicsState()
    shadow(0.4, blur: 3, drop: 1.6)
    NSColor(hex: 0xD9D9DD).setFill()
    note.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(starting: NSColor(hex: 0xCFCFD4), ending: NSColor(hex: 0xE6E6EA))?.draw(in: note, angle: 90)
    let check = NSBezierPath()
    check.move(to: pt(22.5, 37.5))
    check.line(to: pt(29, 44))
    check.line(to: pt(42, 29.5))
    check.lineWidth = 5 * u
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    NSColor(hex: 0x0F0F10).setStroke()
    check.stroke()
    NSGraphicsContext.restoreGraphicsState()

    // The magnet on the top edge.
    let c = pt(32, 15.5)
    let r = 7 * u
    let magnet = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    NSGraphicsContext.saveGraphicsState()
    shadow(0.45, blur: 1.6, drop: 1)
    NSColor(hex: 0xFF6A13).setFill()
    magnet.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(colors: [NSColor(hex: 0xFFA060), NSColor(hex: 0xFF6A13), NSColor(hex: 0xC94A00)])?
        .draw(in: magnet, relativeCenterPosition: NSPoint(x: -0.3, y: 0.4))
    let g = pt(29.8, 13.2)
    NSColor.white.withAlphaComponent(0.55).setFill()
    NSBezierPath(ovalIn: NSRect(x: g.x - 2.2 * u, y: g.y - 2.2 * u, width: 4.4 * u, height: 4.4 * u)).fill()

    ctx.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

/// Menu bar icon: a note under its magnet. A tick when calm, filled with an exclamation mark when something is due.
func menuBarIcon(due: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        guard let ctx = NSGraphicsContext.current else { return false }
        NSColor.black.setFill()
        NSColor.black.setStroke()
        if due {
            NSBezierPath(roundedRect: NSRect(x: 3, y: 1, width: 12, height: 12), xRadius: 2.2, yRadius: 2.2).fill()
            ctx.compositingOperation = .destinationOut
            let bar = NSBezierPath()
            bar.move(to: NSPoint(x: 9, y: 9.8))
            bar.line(to: NSPoint(x: 9, y: 6.6))
            bar.lineWidth = 1.8
            bar.lineCapStyle = .round
            bar.stroke()
            NSBezierPath(ovalIn: NSRect(x: 7.9, y: 2.9, width: 2.2, height: 2.2)).fill()
        } else {
            let note = NSBezierPath(roundedRect: NSRect(x: 3.7, y: 1.7, width: 10.6, height: 10.6), xRadius: 1.8, yRadius: 1.8)
            note.lineWidth = 1.4
            note.stroke()
            let check = NSBezierPath()
            check.move(to: NSPoint(x: 6.4, y: 6.9))
            check.line(to: NSPoint(x: 8.2, y: 5.1))
            check.line(to: NSPoint(x: 11.6, y: 8.9))
            check.lineWidth = 1.4
            check.lineCapStyle = .round
            check.lineJoinStyle = .round
            check.stroke()
        }
        // The magnet, with a small gap around it so it reads at this size.
        ctx.compositingOperation = .destinationOut
        NSBezierPath(ovalIn: NSRect(x: 5.4, y: 9.6, width: 7.2, height: 7.2)).fill()
        ctx.compositingOperation = .sourceOver
        NSBezierPath(ovalIn: NSRect(x: 6.5, y: 10.7, width: 5, height: 5)).fill()
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "pingme"
    return image
}
