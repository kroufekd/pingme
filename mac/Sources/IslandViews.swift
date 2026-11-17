// The island: one black shape at the notch. Task, new task, waiting, people and pairing are its states.
// Sizes, type, colors and motion follow the approved minimal design (design/v2/e-mac-minimal.html).
// Default view is who, what and a check. Everything else waits behind hover, focus or a click.

import AppKit
import SwiftUI

let kIslandWidth: CGFloat = 376
let kIslandSide: CGFloat = 22
let kIslandBottom: CGFloat = 12
var kContentWidth: CGFloat { kIslandWidth - 2 * kIslandSide }

/// Where the island hangs and how big its closed state is.
struct IslandMetrics: Equatable {
    var hasNotch: Bool
    var notchWidth: CGFloat
    var topHeight: CGFloat   // menu bar height at the notch, 0 without a notch

    /// No notch: the island hangs under the menu bar.
    static let fake = IslandMetrics(hasNotch: false, notchWidth: 0, topHeight: 0)
    static let demo = IslandMetrics(hasNotch: true, notchWidth: 184, topHeight: 32)

    static func forScreen(_ s: NSScreen) -> IslandMetrics {
        let top = s.safeAreaInsets.top
        guard top > 0, let l = s.auxiliaryTopLeftArea, let r = s.auxiliaryTopRightArea else { return .fake }
        let w = min(max(120, s.frame.width - l.width - r.width), 400)
        return IslandMetrics(hasNotch: true, notchWidth: w, topHeight: top)
    }

    /// The strip beside the notch, and the top padding of every open state.
    var bar: CGFloat { hasNotch ? topHeight : 32 }

    /// Closed: just the notch, wider with a dot and a count, wider still on hover. Nil: nothing to show.
    func closedSize(count: Int, peek: Bool) -> CGSize? {
        if !hasNotch && count == 0 { return nil }
        let extra: CGFloat = count > 0 ? (peek ? 168 : 60) : (peek ? 76 : 0)
        return CGSize(width: (hasNotch ? notchWidth : 0) + extra, height: bar + (peek ? kPeekSwell : 0))
    }
}

enum IslandMode: Equatable { case closed, task, compose, waiting, people, pair }

enum PeopleLoad: Equatable { case idle, loading, loaded, failed(String) }

/// One contact as the people state shows it.
struct ContactRow: Identifiable, Equatable {
    struct Key: Equatable {
        var kind: String
        var fingerprint: String
    }

    var id: String
    var name: String
    var hasMac: Bool
    /// When a Mac of theirs last checked in, on this Mac's clock.
    var lastSeen: Date?
    var keys: [Key]

    /// A Mac checked in during the last 5 minutes (same rule as the server and the web).
    func online(at now: Date) -> Bool { hasMac && (lastSeen.map { now.timeIntervalSince($0) < 300 } ?? false) }

    static func list(_ r: ContactsReply, now: Date = Date()) -> [ContactRow] {
        r.contacts.map { c in
            ContactRow(
                id: c.userId, name: c.name, hasMac: c.hasMac,
                lastSeen: c.macLastSeen.map { now.addingTimeInterval(($0 - r.now) / 1000) },
                // Macs first: those are the keys pings are sealed to.
                keys: c.devices.sorted { ($0.isMac ? 0 : 1) < ($1.isMac ? 0 : 1) }
                    .compactMap { d in Net.fingerprint(d.publicKey).map { Key(kind: d.isMac ? "Mac" : "Web", fingerprint: $0) } })
        }
    }
}

@MainActor
final class IslandModel: ObservableObject {
    @Published var mode: IslandMode = .closed
    /// What the content shows. Kept while the island folds away.
    @Published var shown: IslandMode = .compose
    @Published var metrics = IslandMetrics.fake
    @Published var height: CGFloat = 120
    @Published var now = Date()
    @Published var bumped = false
    /// Pointer over the island (from an AppKit tracking area, so it works while the app is inactive).
    @Published var hover = false
    /// Closed island under the pointer: a little wider, with a plus.
    @Published var peek = false
    /// Keyboard focus is somewhere in the task, so the hidden buttons show.
    @Published var taskFocused = false
    /// A row under the pointer or keyboard focus (waiting and people lists).
    @Published var hoverRow: String?
    // Task
    @Published var current: TodoTask?
    @Published var replyOpen = false
    @Published var replyText = ""
    @Published var chosenChip: String?
    @Published var sentNote = ""
    // Idle
    @Published var earsCount = 0
    @Published var earsUrgency: Urgency = .green
    // Waiting
    @Published var waitingRows: [TodoTask] = []
    @Published var waitingCount = 0
    // New task
    @Published var newTitle = ""
    @Published var newUrgency: Urgency = .green
    @Published var later = false
    @Published var laterDate = Date()
    @Published var laterRepeat = ""
    @Published var focusRequest = 0
    // People
    @Published var contacts: [ContactRow] = []
    @Published var invites: [Invite] = []
    /// This Mac's key fingerprint, to compare with what the contact sees.
    @Published var myKey: String?
    /// The contact whose detail (fingerprints) is open.
    @Published var openContact: String?
    @Published var peopleLoad: PeopleLoad = .idle
    @Published var personName = ""
    @Published var said = ""
    /// The last invite went through: the note takes the place of the name row.
    @Published var saidOK = false
    @Published var busy = false
    // Pairing
    @Published var pair: Pairing.State = .idle
    /// Snapshots only: which field draws focus and a caret ("reply", "title", "name").
    @Published var stillFocus: String?
}

struct IslandActions {
    var done: (String) -> Void = { _ in }
    var snooze: (String) -> Void = { _ in }
    var reply: (String, String) -> Void = { _, _ in }
    /// Opens the task's Claude Code session in the Claude app.
    var open: (String) -> Void = { _ in }
    /// The island needs the keyboard (a field is about to take focus).
    var wantKeyboard: () -> Void = {}
    var openFromNotch: () -> Void = {}
    /// The count beside the notch: a due task first (it may have been put away with Esc), else the list.
    var openWaiting: () -> Void = {}
    var switchTo: (IslandMode) -> Void = { _ in }
    var add: () -> Void = {}
    var invite: () -> Void = {}
    var revokeInvite: (String) -> Void = { _ in }
    var toggleContact: (String) -> Void = { _ in }
    var pair: () -> Void = {}
    var cancelPair: () -> Void = {}
}

private struct StillKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// Snapshots: no looping animations, and SwiftUI stand-ins for AppKit controls (ImageRenderer cannot draw them).
    var islandStill: Bool {
        get { self[StillKey.self] }
        set { self[StillKey.self] = newValue }
    }
}

private struct HeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The design's spring (`--spring`): quick, with a slight overshoot.
func islandSpring(_ reduce: Bool, _ response: Double = 0.55) -> Animation? {
    reduce ? nil : .spring(response: response, dampingFraction: 0.78)
}

/// The island's own shape: width, height and corners always move on this one spring, together, so the
/// island grows out of the notch the same way in every direction. A small bounce, settled within kIslandSettle.
func shapeSpring(_ reduce: Bool) -> Animation? {
    reduce ? nil : .spring(duration: 0.5, bounce: 0.16)
}

/// Peek on hover: the same spring, shorter.
func peekSpring(_ reduce: Bool) -> Animation? {
    reduce ? nil : .spring(duration: 0.36, bounce: 0.14)
}

/// How long the window waits before it shrinks behind a shrinking island, so it never crops it mid-motion.
let kIslandSettle: Double = 0.75

/// How much the closed island swells downward on hover, so a peek grows in every direction, not only sideways.
let kPeekSwell: CGFloat = 4

/// Content beside the notch fades in a moment after the island starts to widen, and out at once.
private let earsTransition = AnyTransition.asymmetric(
    insertion: .opacity.combined(with: .scale(scale: 0.86)).animation(.spring(duration: 0.3, bounce: 0.1).delay(0.06)),
    removal: .opacity.combined(with: .scale(scale: 0.92)).animation(.easeIn(duration: 0.09)))

// MARK: - Shape

let kIslandEar: CGFloat = 10

/// The notch outline: flush with the top edge, small outward curves at the top, soft corners at the bottom.
struct IslandShape: Shape {
    var radius: CGFloat
    var ear: CGFloat
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(radius, ear) }
        set { radius = newValue.first; ear = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        let e = min(ear, rect.height / 2)
        let r = max(0, min(radius * 1.25, rect.height - e, (rect.width - 2 * ear) / 2))
        let k = r * 0.33
        let x0 = rect.minX + ear, x1 = rect.maxX - ear
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: x0, y: rect.minY + e), control: CGPoint(x: x0, y: rect.minY))
        p.addLine(to: CGPoint(x: x0, y: rect.maxY - r))
        p.addCurve(to: CGPoint(x: x0 + r, y: rect.maxY),
                   control1: CGPoint(x: x0, y: rect.maxY - k), control2: CGPoint(x: x0 + k, y: rect.maxY))
        p.addLine(to: CGPoint(x: x1 - r, y: rect.maxY))
        p.addCurve(to: CGPoint(x: x1, y: rect.maxY - r),
                   control1: CGPoint(x: x1 - k, y: rect.maxY), control2: CGPoint(x: x1, y: rect.maxY - k))
        p.addLine(to: CGPoint(x: x1, y: rect.minY + e))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: x1, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

// MARK: - Root

struct IslandView: View {
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let m = model.metrics
        let open = model.mode != .closed
        let closed = m.closedSize(count: model.earsCount, peek: model.peek)
        let w = open ? kIslandWidth : (closed?.width ?? 0)
        let h = open ? max(model.height, m.bar) : (closed?.height ?? m.bar)
        let r: CGFloat = open ? 26 : 9
        // Small outward curves where the island meets the menu bar, like the real notch. Only while open:
        // the closed window is exactly the notch wide.
        let ear: CGFloat = open ? kIslandEar : 0
        let still = open || reduceMotion
        ZStack(alignment: .top) {
            content
                .frame(width: kIslandWidth, alignment: .top)
                .fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: g.size.height) })
                // The content comes out of the notch with the shape: from a little smaller and soft, to sharp.
                .scaleEffect(still ? 1 : 0.88, anchor: .top)
                .blur(radius: still ? 0 : 6)
                .opacity(open ? 1 : 0)
                .animation(open ? (reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.42, bounce: 0.08).delay(0.07))
                                : .easeIn(duration: 0.12), value: open)
                .allowsHitTesting(open)
            EarsBar(model: model, actions: actions)
                .frame(width: w, height: m.bar)
        }
        .frame(width: w + 2 * ear, height: h, alignment: .top)
        .background {
            Color.black
                .contentShape(Rectangle())
                .onTapGesture { if !open { actions.openFromNotch() } }
                .accessibilityElement()
                .accessibilityLabel(open ? "" : "Otevřít pingme")
                .accessibilityAddTraits(open ? [] : .isButton)
                .accessibilityAction(.default) { if !open { actions.openFromNotch() } }
                .accessibilityHidden(open)
        }
        .clipShape(IslandShape(radius: r, ear: ear))
        .compositingGroup()
        // Tight on purpose: a wide blur reaches the panel edge and shows up as a cut-off line.
        .shadow(color: Color.black.opacity(open ? 0.3 : 0), radius: 6, y: 4)
        .scaleEffect(model.bumped ? 1.035 : 1, anchor: .top)
        .opacity(open || closed != nil ? 1 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .ignoresSafeArea()
        .animation(shapeSpring(reduceMotion), value: open)
        .animation(shapeSpring(reduceMotion), value: model.height)
        .animation(peekSpring(reduceMotion), value: model.peek)
        .animation(shapeSpring(reduceMotion), value: model.earsCount > 0)
        .animation(reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.45), value: model.bumped)
        .onPreferenceChange(HeightKey.self) { h in
            if h > 0, abs(model.height - h) > 0.5 { model.height = h }
        }
        .focusEffectDisabled()
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("pingme")
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.shown {
            case .task:
                if let t = model.current { TaskCard(task: t, model: model, actions: actions) }
            case .compose: ComposeCard(model: model, actions: actions)
            case .waiting: WaitingCard(model: model, actions: actions)
            case .people: PeopleCard(model: model, actions: actions)
            case .pair: PairCard(model: model, actions: actions)
            case .closed: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, model.metrics.bar)
        .padding(.horizontal, kIslandSide)
        .padding(.bottom, kIslandBottom)
    }
}

// MARK: - The strip beside the notch

struct EarsBar: View {
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let closed = model.mode == .closed
        HStack(spacing: 0) {
            if closed { idleEars } else { openEars }
        }
        .font(Geist.font(12, 600))
        .padding(.leading, closed ? 10 : kIslandSide)
        .padding(.trailing, closed ? 10 : kIslandSide - 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var idleEars: some View {
        let n = model.earsCount
        if model.peek {
            if n > 0 {
                Button { actions.openWaiting() } label: {
                    HStack(spacing: 6) { Dot(color: Ink.urgency(model.earsUrgency)); Text(Fmt.waitingShort(n)) }
                }
                .buttonStyle(EarStyle(strong: true))
                .accessibilityLabel("\(Fmt.waitingLabel(n)), otevře seznam")
                .transition(reduceMotion ? .identity : earsTransition)
            }
            Spacer(minLength: 0)
            ear(icon: "plus", label: "Nový úkol") { actions.switchTo(.compose) }
                .transition(reduceMotion ? .identity : earsTransition)
        } else if n > 0 {
            HStack(spacing: 0) {
                Dot(color: Ink.urgency(model.earsUrgency))
                Spacer(minLength: 0)
                Text("\(n)").font(Geist.font(12, 500)).foregroundStyle(Ink.on2).monospacedDigit()
            }
            .accessibilityElement()
            .accessibilityLabel("\(Fmt.waitingLabel(n)), nejnaléhavější \(model.earsUrgency.word)")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.default) { actions.openWaiting() }
            .transition(reduceMotion ? .identity : earsTransition)
        }
    }

    @ViewBuilder private var openEars: some View {
        switch model.shown {
        case .task:
            if let t = model.current {
                let reveal = model.hover || model.taskFocused || model.replyOpen
                HStack(spacing: 6) {
                    Dot(color: Ink.urgency(t.level), live: t.level == .red && t.touchedAt == nil && t.reply == nil)
                    Text(t.level.word)
                }
                .foregroundStyle(Ink.urgency(t.level))
                .frame(minHeight: 24)
                .accessibilityElement(children: .combine)
                Spacer(minLength: 8)
                Text(t.reply == nil ? Fmt.ago(t.showAt, now: model.now) : "")
                    .font(Geist.font(12, 500))
                    .foregroundStyle(Ink.on3)
                    .monospacedDigit()
                    .lineLimit(1)
                    .opacity(reveal ? 1 : 0)
                    .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.25), value: reveal)
            }
        case .compose:
            listEar
            Spacer(minLength: 0)
            ear(icon: "user", label: "Lidé") { actions.switchTo(.people) }
        case .waiting:
            ear(icon: "plus", label: "Nový úkol") { actions.switchTo(.compose) }
            Spacer(minLength: 0)
            ear(icon: "user", label: "Lidé") { actions.switchTo(.people) }
        case .people, .pair:
            listEar
            Spacer(minLength: 0)
            ear(icon: "plus", label: "Nový úkol") { actions.switchTo(.compose) }
        case .closed:
            EmptyView()
        }
    }

    private var listEar: some View {
        let n = model.waitingCount
        return Button { actions.switchTo(.waiting) } label: {
            HStack(spacing: 6) {
                Icon(name: "list", size: 15, color: .white)
                if n > 0 { Text("\(n)").monospacedDigit() }
            }
        }
        .buttonStyle(EarStyle())
        .accessibilityLabel(n > 0 ? "Čeká, \(Fmt.tasks(n))" : "Čeká")
        .help("Čeká")
    }

    private func ear(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(name: icon, size: 15, color: .white) }
            .buttonStyle(EarStyle())
            .accessibilityLabel(label)
            .help(label)
    }
}

// MARK: - Bits

/// The urgency dot. Hned pulses (a ring that grows and fades) until the owner clicks.
struct Dot: View {
    let color: Color
    var size: CGFloat = 8
    var live = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.islandStill) private var still

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay {
                if live && !reduceMotion && !still {
                    TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
                        let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                        let x = min(1, t / 0.7)
                        let p = 1 - pow(1 - x, 3)
                        Circle()
                            .fill(Color(hex: 0xFFBBB2, opacity: 0.55 * (1 - p)))
                            .frame(width: size + 14 * p, height: size + 14 * p)
                    }
                    .allowsHitTesting(false)
                }
            }
            .accessibilityHidden(true)
    }
}

/// White ring 2 px outside the control, like the design's `:focus-visible`.
private struct FocusRing<S: InsettableShape>: ViewModifier {
    let shape: S
    let on: Bool
    func body(content: Content) -> some View {
        content.overlay { if on { shape.inset(by: -3).stroke(Color.white, lineWidth: 2) } }
    }
}

/// Quiet buttons beside the notch (`.ear`).
struct EarStyle: ButtonStyle {
    var strong = false
    func makeBody(configuration: Configuration) -> some View { EarBody(config: configuration, strong: strong) }
}

private struct EarBody: View {
    let config: ButtonStyle.Configuration
    let strong: Bool
    @State private var hover = false
    @Environment(\.isFocused) private var focused

    var body: some View {
        let lit = hover || focused
        config.label
            .font(Geist.font(12, 600))
            .foregroundStyle(Ink.on2)
            .padding(.horizontal, 6)
            .frame(minHeight: 24)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(lit ? Ink.island2 : .clear))
            .opacity(strong || lit ? 1 : 0.6)
            .contentShape(Rectangle())
            .modifier(FocusRing(shape: RoundedRectangle(cornerRadius: 8, style: .continuous), on: focused))
            .padding(.horizontal, -6)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.2), value: lit)
    }
}

/// The dark pill (`.q`): Odpovědět, 10 min, reply chips, day, time, repeat, Pozvat, Klíč.
struct QStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { QBody(config: configuration) }
}

private struct QBody: View {
    let config: ButtonStyle.Configuration
    @State private var hover = false
    @Environment(\.isFocused) private var focused
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        config.label
            .font(Geist.font(12.5, 550))
            .foregroundStyle(Ink.on)
            .lineLimit(1)
            .padding(.horizontal, 11)
            .frame(height: 28)
            .background(Capsule().fill(hover && enabled ? Ink.island3 : Ink.island2))
            .contentShape(Capsule())
            .modifier(FocusRing(shape: Capsule(), on: focused))
            .scaleEffect(config.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(enabled ? 1 : 0.5)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.2), value: hover)
            .animation(islandSpring(reduceMotion, 0.3), value: config.isPressed)
    }
}

/// Icon and text inside a `.q` pill.
struct QLabel: View {
    var icon: String?
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            if let icon { Icon(name: icon, size: 14, color: .white).opacity(0.85) }
            Text(text)
        }
    }
}

/// Round buttons: the check (32), send arrows (24, 28) and the clock (28).
struct RoundStyle: ButtonStyle {
    enum Kind { case filled, quiet(expanded: Bool) }
    var size: CGFloat
    var kind: Kind = .filled
    var grow = false
    func makeBody(configuration: Configuration) -> some View { RoundBody(config: configuration, style: self) }
}

private struct RoundBody: View {
    let config: ButtonStyle.Configuration
    let style: RoundStyle
    @State private var hover = false
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let fill: Color
        let opacity: Double
        switch style.kind {
        case .filled:
            fill = Ink.on
            opacity = 1
        case .quiet(let expanded):
            fill = expanded ? Ink.island3 : (hover ? Ink.island2 : .clear)
            opacity = expanded || hover || focused ? 1 : 0.65
        }
        let scale: CGFloat = reduceMotion ? 1 : (config.isPressed ? (style.grow ? 0.94 : 0.92) : (style.grow && hover ? 1.08 : 1))
        return config.label
            .frame(width: style.size, height: style.size)
            .background(Circle().fill(fill))
            .opacity(opacity)
            .contentShape(Circle())
            .modifier(FocusRing(shape: Circle(), on: focused))
            .scaleEffect(scale)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.2), value: hover)
            .animation(islandSpring(reduceMotion, 0.35), value: scale)
    }
}

/// A text field without any frame. Snapshots draw a stand-in, with a caret when it has focus.
struct BareField: View {
    let placeholder: String
    @Binding var text: String
    var font: Font
    var placeholderFont: Font?
    var color: Color = .white
    var limit: Int
    var focus: FocusState<Bool>.Binding
    var stillFocused = false
    var onSubmit: () -> Void

    @Environment(\.islandStill) private var still

    var body: some View {
        Group {
            if still {
                HStack(spacing: 1) {
                    Text(text.isEmpty ? placeholder : text)
                        .font(text.isEmpty ? (placeholderFont ?? font) : font)
                        .foregroundStyle(text.isEmpty ? Ink.on3 : color)
                        .lineLimit(1)
                    if stillFocused && !text.isEmpty { Rectangle().fill(Ink.on).frame(width: 1.5, height: 16) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                TextField("", text: $text, prompt: Text(placeholder).font(placeholderFont ?? font).foregroundStyle(Ink.on3))
                    .textFieldStyle(.plain)
                    .foregroundStyle(color)
                    .focused(focus)
                    .onSubmit(onSubmit)
            }
        }
        .font(font)
        .onChange(of: text) { _, v in if v.count > limit { text = String(v.prefix(limit)) } }
        .accessibilityLabel(placeholder)
    }
}

/// The widest line a title needs, so two lines come out about even (CSS `text-wrap: balance`).
@MainActor
private func balancedWidth(_ text: String, font: NSFont, kerning: CGFloat, lineHeight: CGFloat, max maxWidth: CGFloat) -> CGFloat {
    let s = NSAttributedString(string: text, attributes: [.font: font, .kern: kerning])
    func lines(_ w: CGFloat) -> Int {
        let r = s.boundingRect(with: CGSize(width: w, height: 10_000), options: [.usesLineFragmentOrigin])
        return max(1, Int((r.height / (font.ascender - font.descender + font.leading)).rounded()))
    }
    let n = lines(maxWidth)
    guard n > 1 else { return maxWidth }
    var lo = maxWidth / 2, hi = maxWidth
    while hi - lo > 1 {
        let mid = (lo + hi) / 2
        if lines(mid) > n { lo = mid } else { hi = mid }
    }
    return min(maxWidth, hi + 2)
}

// MARK: - Task

struct TaskCard: View {
    let task: TodoTask
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @FocusState private var focus: Spot?
    @FocusState private var fieldFocused: Bool
    @Environment(\.islandStill) private var still
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Spot: Hashable { case done, reply, open, snooze, chip(Int), send }

    private var reveal: Bool { model.hover || focus != nil }
    private static let titleWidth = kContentWidth - 12 - 32

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 0) {
                    who
                    Text(task.title)
                        .font(Geist.font(15, 600))
                        .kerning(-0.15)
                        .lineSpacing(0.5)
                        // A placeholder for text that did not decrypt: quieter than a real message.
                        .foregroundStyle(task.unreadable == true ? Ink.on2 : Color.white)
                        // A finished session is a glance, not a read: three lines at most.
                        .lineLimit(task.isAgentSession ? 3 : nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: balancedWidth(task.title, font: Geist.nsFont(15, 600), kerning: -0.15,
                                                    lineHeight: 20, max: Self.titleWidth), alignment: .leading)
                        .padding(.top, 1)
                        .padding(.vertical, 0.5)
                    if task.forAgent, let report = task.report, !report.isEmpty {
                        Text(report)
                            .font(Geist.font(12.5))
                            .lineSpacing(2)
                            .foregroundStyle(Ink.on2)
                            .lineLimit(8)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(width: Self.titleWidth, alignment: .leading)
                            .padding(.top, 6)
                            .accessibilityLabel("Report agenta: \(report)")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button { actions.done(task.id) } label: { Icon(name: "check", size: 16, color: .black) }
                    .buttonStyle(RoundStyle(size: 32, grow: true))
                    .focused($focus, equals: .done)
                    .accessibilityLabel("Hotovo")
            }
            .padding(.top, 6)

            if model.replyOpen && task.canReply {
                replyStack
                    .transition(.opacity)
            } else {
                if !model.sentNote.isEmpty { note }
                more
            }
        }
        .animation(islandSpring(reduceMotion, 0.45), value: model.replyOpen)
        .animation(islandSpring(reduceMotion, 0.45), value: model.replyText.isEmpty)
        .onChange(of: focus) { _, f in model.taskFocused = f != nil || fieldFocused }
        .onChange(of: fieldFocused) { _, f in model.taskFocused = f || focus != nil }
        .accessibilityElement(children: .contain)
    }

    private var who: some View {
        HStack(spacing: 5) {
            if task.kind == .agent || task.isAgentSession || task.forAgent {
                Icon(name: "robot", size: 13, color: .white).opacity(0.8)
            }
            Text(whoText).lineLimit(1)
            // Its own element that never shrinks: the server picks the name, it must not push this off.
            if let marker = Self.marker(task) {
                Text("· \(marker)")
                    .foregroundStyle(Ink.urgency(.orange))
                    .fixedSize()
                    .layoutPriority(1)
            }
        }
        .font(Geist.font(12, 500))
        .foregroundStyle(Ink.on2)
        .frame(height: 16)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.whoLabel(task))
    }

    private var whoText: String { Self.whoText(task) }

    static func whoText(_ task: TodoTask) -> String {
        if task.isAgentSession { return "Claude · \(task.fromName)" }
        if task.forAgent { return "\(task.fromName) pro agenta" }
        // A ping an agent sent through someone's Mac: "Michal · agent".
        if task.fromAgent != nil && task.fromUserId != nil { return "\(task.fromName) · agent" }
        return task.fromName
    }

    /// "nešifrované" on a legacy plaintext ping, nil otherwise.
    static func marker(_ task: TodoTask) -> String? { task.plain == true ? Net.plainMarker : nil }

    static func whoLabel(_ task: TodoTask) -> String {
        let who = whoText(task) + (marker(task).map { ", \($0)" } ?? "")
        return task.kind == .agent ? "Od agenta, \(who)" : "Od \(who)"
    }

    /// Odpovědět and 10 min, folded away until hover or keyboard focus.
    private var more: some View {
        HStack(spacing: 6) {
            if task.canReply {
                Button {
                    actions.wantKeyboard()
                    model.replyOpen = true
                } label: { QLabel(icon: "reply", text: "Odpovědět") }
                .buttonStyle(QStyle())
                .focused($focus, equals: .reply)
                .accessibilityLabel(task.isAgentSession ? "Odpovědět agentovi" : "Odpovědět")
            }
            if let session = task.agentSession, !session.isEmpty {
                Button { actions.open(task.id) } label: { QLabel(icon: "open", text: "Otevřít") }
                    .buttonStyle(QStyle())
                    .focused($focus, equals: .open)
                    .accessibilityLabel("Otevřít session v Claude")
            }
            Button { actions.snooze(task.id) } label: { QLabel(icon: "snooze", text: "\(kSnoozeMinutes) min") }
                .buttonStyle(QStyle())
                .focused($focus, equals: .snooze)
                .accessibilityLabel("Odložit o \(kSnoozeMinutes) minut")
        }
        .padding(.top, 10)
        .opacity(reveal ? 1 : 0)
        .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.2).delay(reveal ? 0.08 : 0), value: reveal)
        .frame(height: reveal ? 38 : 0, alignment: .top)
        .clipped()
        .animation(islandSpring(reduceMotion, 0.45), value: reveal)
        // VoiceOver cannot hover, so these stay in its reach while folded away.
    }

    private var note: some View {
        HStack(spacing: 6) {
            Icon(name: "reply", size: 14, color: .white).opacity(0.7)
            Text(model.sentNote).lineLimit(1).truncationMode(.tail)
        }
        .frame(height: 18.125)
        .font(Geist.font(12.5))
        .foregroundStyle(Ink.on2)
        .padding(.top, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Odpověděl jsi: \(model.sentNote)")
    }

    /// Three chips and a field. Typing moves the chips aside and brings the arrow.
    private var replyStack: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.replyText.isEmpty && !task.isAgentSession {
                HStack(spacing: 6) {
                    ForEach(Array(kReplyChips.enumerated()), id: \.offset) { i, c in
                        Button(c) { actions.reply(task.id, c) }
                            .buttonStyle(QStyle())
                            .focused($focus, equals: .chip(i))
                            .accessibilityLabel("Odpovědět: \(c)")
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Rychlá odpověď")
                .transition(.opacity)
            }
            HStack(spacing: 8) {
                BareField(placeholder: task.isAgentSession ? "Napiš agentovi" : "Nebo napiš", text: $model.replyText, font: Geist.font(13), color: Ink.on,
                          limit: kReplyMax, focus: $fieldFocused, stillFocused: model.stillFocus == "reply", onSubmit: sendText)
                    .onAppear { fieldFocused = true }
                    .accessibilityLabel("Vlastní odpověď")
                if !model.replyText.isEmpty {
                    Button(action: sendText) { Icon(name: "send", size: 14, color: .black) }
                        .buttonStyle(RoundStyle(size: 24))
                        .focused($focus, equals: .send)
                        .accessibilityLabel("Odeslat odpověď")
                        .transition(.opacity)
                }
            }
            .padding(.leading, 11)
            .padding(.trailing, 4)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Ink.island2))
            .overlay {
                if fieldFocused || (still && model.stillFocus == "reply") {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white, lineWidth: 1.5)
                }
            }
        }
        .padding(.top, 10)
    }

    private func sendText() {
        let v = model.replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty else { return }
        actions.reply(task.id, v)
    }
}

// MARK: - New task

struct ComposeCard: View {
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @FocusState private var titleFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var typing: Bool { !model.newTitle.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BareField(placeholder: "Co je potřeba?", text: $model.newTitle, font: Geist.font(15, 600),
                      placeholderFont: Geist.font(15, 500), limit: kTitleMax,
                      focus: $titleFocused, stillFocused: model.stillFocus == "title", onSubmit: actions.add)
                .kerning(-0.15)
                .frame(height: 32)
                .padding(.top, 4)
                .accessibilityLabel("Úkol")
            if typing {
                HStack(spacing: 6) {
                    UrgencyWords(selection: $model.newUrgency)
                        .padding(.leading, -8)
                    Spacer(minLength: 0)
                    Button {
                        if !model.later { model.laterDate = ComposeCard.nextHour() }
                        model.later.toggle()
                    } label: { Icon(name: "clock", size: 15, color: .white) }
                    .buttonStyle(RoundStyle(size: 28, kind: .quiet(expanded: model.later)))
                    .accessibilityLabel("Později")
                    .accessibilityValue(model.later ? "rozbaleno" : "sbaleno")
                    .help("Později")
                    Button(action: actions.add) { Icon(name: "send", size: 14, color: .black) }
                        .buttonStyle(RoundStyle(size: 28))
                        .accessibilityLabel("Přidat úkol")
                        .help("Přidat úkol")
                }
                .padding(.top, 6)
                .transition(.opacity)
                if model.later {
                    LaterRow(model: model)
                        .padding(.top, 8)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4)))
                }
            }
        }
        .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.35), value: model.later)
        .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.3), value: typing)
        .onAppear { titleFocused = true }
        .onChange(of: model.focusRequest) { _, _ in titleFocused = true }
    }

    static func nextHour(after now: Date = Date()) -> Date {
        let cal = Calendar.current
        let start = cal.dateInterval(of: .hour, for: now)?.start ?? now
        return start.addingTimeInterval(3600)
    }
}

/// Počká, Brzy, Hned as three words. The chosen one gets its color and a dot.
struct UrgencyWords: View {
    @Binding var selection: Urgency

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Urgency.allCases, id: \.self) { u in
                Button { selection = u } label: { Text(u.word) }
                    .buttonStyle(WordStyle(urgency: u, on: selection == u))
                    .accessibilityLabel(u.word)
                    .accessibilityAddTraits(selection == u ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Jak moc to spěchá")
    }
}

private struct WordStyle: ButtonStyle {
    let urgency: Urgency
    let on: Bool
    func makeBody(configuration: Configuration) -> some View { WordBody(config: configuration, urgency: urgency, on: on) }
}

private struct WordBody: View {
    let config: ButtonStyle.Configuration
    let urgency: Urgency
    let on: Bool
    @State private var hover = false
    @Environment(\.isFocused) private var focused

    var body: some View {
        HStack(spacing: 6) {
            if on { Dot(color: Ink.urgency(urgency), size: 7) }
            config.label
        }
        .font(Geist.font(12.5, on ? 600 : 550))
        .foregroundStyle(on ? Ink.urgency(urgency) : (hover ? Ink.on : Ink.on3))
        .padding(.horizontal, 8)
        .frame(height: 28)
        .contentShape(Capsule())
        .modifier(FocusRing(shape: Capsule(), on: focused))
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.2), value: hover)
    }
}

/// Day, time and repeat behind the clock. Each pill opens a menu.
struct LaterRow: View {
    @ObservedObject var model: IslandModel

    private static let repeatOptions: [(String, String)] = [("", "Jednou")] + Recurrence.all.map { ($0, Recurrence.label($0) ?? $0) }

    var body: some View {
        let cal = Calendar.current
        let today = cal.startOfDay(for: model.now)
        let days = (0..<14).compactMap { cal.date(byAdding: .day, value: $0, to: today) }
        let hm = cal.dateComponents([.hour, .minute], from: model.laterDate)
        let slot = (hm.hour ?? 0) * 4 + (hm.minute ?? 0) / 15
        HStack(spacing: 6) {
            MenuPill(text: Fmt.dayLabel(model.laterDate, now: model.now), a11y: "Den",
                     items: days.map { (Fmt.dayLabel($0, now: model.now), cal.isDate($0, inSameDayAs: model.laterDate)) }) { i in
                guard days.indices.contains(i) else { return }
                let d = cal.date(bySettingHour: hm.hour ?? 9, minute: hm.minute ?? 0, second: 0, of: days[i]) ?? days[i]
                model.laterDate = d
            }
            MenuPill(text: Fmt.clock(model.laterDate), a11y: "Čas",
                     items: (0..<96).map { (String(format: "%d:%02d", $0 / 4, ($0 % 4) * 15), $0 == slot) }) { i in
                let d = cal.date(bySettingHour: i / 4, minute: (i % 4) * 15, second: 0, of: model.laterDate) ?? model.laterDate
                model.laterDate = d
            }
            MenuPill(text: Self.repeatOptions.first { $0.0 == model.laterRepeat }?.1 ?? "Jednou", icon: "repeat", a11y: "Opakování",
                     items: Self.repeatOptions.map { ($0.1, $0.0 == model.laterRepeat) }) { i in
                if Self.repeatOptions.indices.contains(i) { model.laterRepeat = Self.repeatOptions[i].0 }
            }
        }
    }
}

/// A `.q` pill that opens a native menu under itself.
struct MenuPill: View {
    let text: String
    var icon: String?
    let a11y: String
    let items: [(String, Bool)]
    let pick: (Int) -> Void
    @State private var anchor = AnchorBox()
    @Environment(\.islandStill) private var still

    var body: some View {
        Button(action: show) { QLabel(icon: icon, text: text) }
            .buttonStyle(QStyle())
            .background { if !still { MenuAnchor(box: anchor) } }
            .accessibilityLabel(a11y)
            .accessibilityValue(text)
    }

    private func show() {
        guard let v = anchor.view else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        let target = MenuTarget(pick)
        var selected: NSMenuItem?
        for (i, (title, on)) in items.enumerated() {
            let item = NSMenuItem(title: title, action: #selector(MenuTarget.choose(_:)), keyEquivalent: "")
            item.target = target
            item.tag = i
            item.state = on ? .on : .off
            menu.addItem(item)
            if on { selected = item }
        }
        withExtendedLifetime(target) {
            _ = menu.popUp(positioning: selected, at: NSPoint(x: 0, y: v.isFlipped ? 0 : v.bounds.height), in: v)
        }
    }
}

final class AnchorBox { weak var view: NSView? }

private struct MenuAnchor: NSViewRepresentable {
    let box: AnchorBox
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        box.view = v
        return v
    }
    func updateNSView(_ v: NSView, context: Context) { box.view = v }
}

private final class MenuTarget: NSObject {
    let pick: (Int) -> Void
    init(_ pick: @escaping (Int) -> Void) { self.pick = pick }
    @objc func choose(_ sender: NSMenuItem) { pick(sender.tag) }
}

// MARK: - Lists

/// One 30 px row. Highlights on hover or keyboard focus, which also shows its hidden parts.
private struct ListRow<Content: View>: View {
    let id: String
    @ObservedObject var model: IslandModel
    @FocusState.Binding var focused: String?
    let focusable: Bool
    @ViewBuilder var content: (Bool) -> Content

    var body: some View {
        let lit = model.hoverRow == id || focused == id
        let row = HStack(spacing: 10) { content(lit) }
            .font(Geist.font(13))
            .foregroundStyle(Ink.on)
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(lit ? Ink.island2 : .clear))
            .contentShape(Rectangle())
        Group {
            if focusable {
                // Rows without their own buttons take focus themselves, so the keyboard reveals them too.
                row.focusable()
                    .focused($focused, equals: id)
                    .modifier(FocusRing(shape: RoundedRectangle(cornerRadius: 9, style: .continuous), on: focused == id))
            } else {
                row
            }
        }
        .padding(.horizontal, -8)
        .onHover { inside in
            if inside { model.hoverRow = id } else if model.hoverRow == id { model.hoverRow = nil }
        }
        .animation(.easeOut(duration: 0.2), value: lit)
    }
}

private struct QuietLine: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Geist.font(13))
            .foregroundStyle(Ink.on3)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
    }
}

// MARK: - Waiting

struct WaitingCard: View {
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @FocusState private var focused: String?
    static let maxRows = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.waitingRows.isEmpty {
                QuietLine(text: "Nic nečeká.")
            } else {
                ForEach(model.waitingRows.prefix(Self.maxRows), id: \.id) { t in
                    ListRow(id: t.id, model: model, focused: $focused, focusable: true) { lit in
                        WaitingRowContent(task: t, now: model.now, lit: lit)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(WaitingRowContent.label(t, now: model.now))
                }
                if model.waitingRows.count > Self.maxRows {
                    Text("a ještě \(Fmt.tasks(model.waitingRows.count - Self.maxRows))")
                        .font(Geist.font(12.5))
                        .foregroundStyle(Ink.on3)
                        .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                        .padding(.leading, 18)
                }
            }
        }
        .padding(.top, 4)
        .onChange(of: focused) { _, f in model.hoverRow = f }
    }
}

private struct WaitingRowContent: View {
    let task: TodoTask
    let now: Date
    let lit: Bool

    static func sub(_ t: TodoTask, now: Date) -> String {
        var parts = [t.kind == .owner && t.source != "web" ? "ode mě" : t.createdByName]
        if let m = TaskCard.marker(t) { parts.append(m) }
        if t.isSnoozed(at: now) { parts.append("odloženo") }
        if let r = t.repeat.flatMap(Recurrence.label) { parts.append(r.prefix(1).lowercased() + r.dropFirst()) }
        return parts.joined(separator: ", ")
    }

    static func label(_ t: TodoTask, now: Date) -> String {
        [t.title, t.level.word, sub(t, now: now), Fmt.when(t.showAt, now: now)].joined(separator: ", ")
    }

    var body: some View {
        Dot(color: Ink.urgency(task.level))
        Text(task.title)
            .font(Geist.font(13, 550))
            .lineLimit(1)
            .truncationMode(.tail)
            .layoutPriority(1)
        if lit {
            Text(Self.sub(task, now: now))
                .foregroundStyle(Ink.on3)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        Spacer(minLength: 0)
        Text(Fmt.when(task.showAt, now: now))
            .font(Geist.font(12.5))
            .foregroundStyle(Ink.on2)
            .monospacedDigit()
            .fixedSize()
    }
}

// MARK: - People

struct PeopleCard: View {
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @FocusState private var nameFocused: Bool
    @FocusState private var focused: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var named: Bool { !model.personName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                if model.contacts.isEmpty && model.invites.isEmpty {
                    QuietLine(text: emptyText)
                } else {
                    ForEach(model.contacts) { c in
                        ListRow(id: c.id, model: model, focused: $focused, focusable: true) { lit in
                            ContactRowContent(contact: c, now: model.now, lit: lit, open: model.openContact == c.id)
                        }
                        .onTapGesture { actions.toggleContact(c.id) }
                        .onKeyPress(.return) { actions.toggleContact(c.id); return .handled }
                        .onKeyPress(.space) { actions.toggleContact(c.id); return .handled }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(ContactRowContent.label(c, now: model.now))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint("Otisk klíče")
                        .accessibilityAction(.default) { actions.toggleContact(c.id) }
                        if model.openContact == c.id {
                            KeyDetail(contact: c, mine: model.myKey)
                                .transition(.opacity)
                        }
                    }
                    ForEach(model.invites) { i in
                        ListRow(id: i.id, model: model, focused: $focused, focusable: false) { lit in
                            InviteRowContent(invite: i, lit: lit, onRemove: { actions.revokeInvite(i.id) }, focused: $focused)
                        }
                    }
                }
            }
            .padding(.top, 4)
            .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.25), value: model.openContact)
            if model.saidOK && !model.said.isEmpty {
                saidNote
            } else {
                addRow
                if !model.said.isEmpty {
                    Text(model.said)
                        .font(Geist.font(12))
                        .foregroundStyle(Ink.on2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                }
            }
        }
        .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.25), value: named)
        .onChange(of: focused) { _, f in model.hoverRow = f }
    }

    private var addRow: some View {
        HStack(spacing: 6) {
            BareField(placeholder: "Přidat jméno", text: $model.personName, font: Geist.font(13, 500), limit: kNameMax,
                      focus: $nameFocused, stillFocused: model.stillFocus == "name",
                      onSubmit: { if named && !model.busy { actions.invite() } })
                .accessibilityLabel("Jméno")
            if named {
                Button(action: actions.invite) { QLabel(icon: "link", text: "Pozvat") }
                    .buttonStyle(QStyle())
                    .disabled(model.busy)
                    .accessibilityLabel("Pozvat, zkopíruje odkaz")
                    .transition(.opacity)
            }
        }
        .frame(height: 32)
        .padding(.top, 4)
    }

    /// Shown once after an invite, in place of the name row.
    private var saidNote: some View {
        Text(model.said)
            .font(Geist.font(12))
            .foregroundStyle(Ink.on2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 16.2, alignment: .leading)
            .padding(.top, 6)
    }

    private var emptyText: String {
        switch model.peopleLoad {
        case .idle, .loading: return "Načítám..."
        case .failed(let m): return m
        case .loaded: return "Zatím nikdo. Napiš jméno a pozvi ho."
        }
    }
}

/// Online (a Mac checked in during the last 5 minutes), offline, or no Mac at all (hollow).
private struct OnlineDot: View {
    let online: Bool
    let hasMac: Bool

    var body: some View {
        Group {
            if hasMac {
                Circle().fill(online ? Ink.urgency(.green) : Ink.edge)
            } else {
                Circle().strokeBorder(Ink.edge, lineWidth: 1.2)
            }
        }
        .frame(width: 8, height: 8)
        .frame(width: 14)
        .accessibilityHidden(true)
    }
}

private struct ContactRowContent: View {
    let contact: ContactRow
    let now: Date
    let lit: Bool
    let open: Bool

    static func detail(_ c: ContactRow, now: Date) -> String {
        if !c.hasMac { return "nemá appku" }
        if c.online(at: now) { return "online" }
        return c.lastSeen.map { Fmt.ago($0, now: now) } ?? "offline"
    }

    static func label(_ c: ContactRow, now: Date) -> String { "\(c.name), \(detail(c, now: now))" }

    var body: some View {
        OnlineDot(online: contact.online(at: now), hasMac: contact.hasMac)
        Text(contact.name)
            .font(Geist.font(13, 550))
            .foregroundStyle(contact.hasMac ? Ink.on : Ink.on2)
            .lineLimit(1)
            .truncationMode(.tail)
            .layoutPriority(1)
        Text(Self.detail(contact, now: now))
            .foregroundStyle(Ink.on3)
            .lineLimit(1)
            .opacity(lit || open ? 1 : 0)
        Spacer(minLength: 0)
        Icon(name: "key", size: 13, color: .white)
            .opacity(lit || open ? 0.6 : 0)
    }
}

/// Key fingerprints of a contact's devices and of this Mac. Both people open each other's detail
/// and read the same numbers.
private struct KeyDetail: View {
    let contact: ContactRow
    let mine: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if contact.keys.isEmpty {
                line("", "Žádné zařízení")
            }
            ForEach(Array(contact.keys.prefix(4).enumerated()), id: \.offset) { _, k in
                line(k.kind, k.fingerprint)
            }
            if let mine { line("Tento Mac", mine) }
        }
        .padding(.leading, 24)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Otisky klíčů")
    }

    private func line(_ label: String, _ value: String) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(Geist.font(12, 500))
                .foregroundStyle(Ink.on3)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(Geist.mono(12))
                .foregroundStyle(Ink.on2)
                .textSelection(.enabled)
        }
        .frame(minHeight: 18)
    }
}

private struct InviteRowContent: View {
    let invite: Invite
    let lit: Bool
    let onRemove: () -> Void
    @FocusState.Binding var focused: String?

    private var detail: String {
        if let email = invite.email, !email.isEmpty { return email }
        return invite.expiresAt.map { "do \(Fmt.day(Date(ms: $0)))" } ?? "pozvánka"
    }

    var body: some View {
        let show = lit || focused == invite.id
        HStack(spacing: 10) {
            Icon(name: "link", size: 14, color: .white).opacity(0.7).frame(width: 14)
            Text(invite.name)
                .font(Geist.font(13, 550))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            Text(detail)
                .foregroundStyle(Ink.on3)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(invite.name), pozvánka, \(detail)")
        Spacer(minLength: 0)
        Button(action: onRemove) { Icon(name: "x", size: 12, color: .white) }
            .buttonStyle(RemoveStyle(visible: show))
            .focused($focused, equals: invite.id)
            .accessibilityLabel("Zrušit pozvánku pro \(invite.name)")
            .help("Zrušit pozvánku")
            .padding(.trailing, -5)
    }
}

/// The x at the end of an invite row: hidden until the row is hovered or focused.
private struct RemoveStyle: ButtonStyle {
    let visible: Bool
    func makeBody(configuration: Configuration) -> some View { RemoveBody(config: configuration, visible: visible) }
}

private struct RemoveBody: View {
    let config: ButtonStyle.Configuration
    let visible: Bool
    @State private var hover = false
    @Environment(\.isFocused) private var focused

    var body: some View {
        config.label
            .frame(width: 24, height: 24)
            .background(Circle().fill(hover ? Ink.island3 : .clear))
            .contentShape(Circle())
            .modifier(FocusRing(shape: Circle(), on: focused))
            .opacity(visible || focused ? 1 : 0)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.2), value: visible)
    }
}

// MARK: - Pairing

/// "Připojit tento Mac": one button. Then a quiet wait for the browser, with a way out.
struct PairCard: View {
    @ObservedObject var model: IslandModel
    let actions: IslandActions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.pair {
            case .idle, .failed:
                HStack(spacing: 10) {
                    Button(action: actions.pair) { Text("Připojit tento Mac") }
                        .buttonStyle(PrimaryStyle())
                        .accessibilityHint("Otevře prohlížeč, kde Mac potvrdíš")
                    if case .failed(let why) = model.pair {
                        Text(why)
                            .font(Geist.font(12))
                            .foregroundStyle(Ink.on2)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            case .starting, .waiting:
                HStack(spacing: 10) {
                    Waiting()
                    if case .waiting(let code) = model.pair {
                        HStack(spacing: 8) {
                            Text("Kód do prohlížeče")
                                .font(Geist.font(13, 550))
                                .foregroundStyle(Ink.on2)
                                .lineLimit(1)
                                .fixedSize()
                            Text("\(code.prefix(3)) \(code.suffix(3))")
                                .font(Geist.mono(17))
                                .foregroundStyle(Ink.on)
                                .monospacedDigit()
                                .fixedSize()
                                .textSelection(.enabled)
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Kód do prohlížeče: \(code.map(String.init).joined(separator: " "))")
                    } else {
                        Text("Otevírám prohlížeč")
                            .font(Geist.font(13, 550))
                            .foregroundStyle(Ink.on)
                    }
                    Spacer(minLength: 0)
                    if case .waiting = model.pair {
                        Button(action: actions.pair) { Icon(name: "open", size: 12, color: .white) }
                            .buttonStyle(RoundStyle(size: 28, kind: .quiet(expanded: false)))
                            .help("Otevřít stránku znovu")
                            .accessibilityLabel("Otevřít stránku znovu")
                    }
                    Button(action: actions.cancelPair) { Icon(name: "x", size: 12, color: .white) }
                        .buttonStyle(RoundStyle(size: 28, kind: .quiet(expanded: false)))
                        .accessibilityLabel("Zrušit připojení")
                        .help("Zrušit")
                }
                .frame(height: 32)
            case .done(let name):
                HStack(spacing: 10) {
                    Dot(color: Ink.urgency(.green))
                    Text(name.isEmpty ? "Připojeno" : "Připojeno, \(name)")
                        .font(Geist.font(13, 550))
                        .foregroundStyle(Ink.on)
                }
                .frame(height: 32)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
        .animation(reduceMotion ? nil : .timingCurve(0.3, 0.7, 0.2, 1, duration: 0.25), value: model.pair)
    }
}

/// The white pill: the one main action of a state.
struct PrimaryStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { PrimaryBody(config: configuration) }
}

private struct PrimaryBody: View {
    let config: ButtonStyle.Configuration
    @State private var hover = false
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        config.label
            .font(Geist.font(13, 600))
            .foregroundStyle(Color.black)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: 32)
            .background(Capsule().fill(Ink.on.opacity(hover ? 0.88 : 1)))
            .contentShape(Capsule())
            .modifier(FocusRing(shape: Capsule(), on: focused))
            .scaleEffect(config.isPressed && !reduceMotion ? 0.96 : 1)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.2), value: hover)
            .animation(islandSpring(reduceMotion, 0.3), value: config.isPressed)
    }
}

/// Three dots that breathe while the browser is open. Still in snapshots and with reduced motion.
private struct Waiting: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.islandStill) private var still

    var body: some View {
        Group {
            if reduceMotion || still {
                dots { _ in 0.7 }
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
                    let t = ctx.date.timeIntervalSinceReferenceDate
                    dots { i in 0.35 + 0.65 * (0.5 + 0.5 * sin((t * 4) - Double(i) * 0.9)) }
                }
            }
        }
        .frame(width: 22, height: 8)
        .accessibilityHidden(true)
    }

    private func dots(_ alpha: @escaping (Int) -> Double) -> some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { i in Circle().fill(Ink.on.opacity(alpha(i))).frame(width: 5, height: 5) }
        }
    }
}
