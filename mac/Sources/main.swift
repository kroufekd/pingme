// pingme for Mac, v2.
// Tasks are stored only here, on the Mac. People (web) and agents (MCP) send tasks through the server,
// the Mac picks them up over a live Convex feed, confirms them through /mac/sync and reports statuses back.
// Everything shows in one island at the notch: a due task, a new task, what waits, and people.

import AppKit

let args = CommandLine.arguments

func value(after flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// Dev commands never fall through to the real app.
if let i = args.firstIndex(of: "--render-icon") {
    guard i + 2 < args.count, let size = Int(args[i + 2]) else {
        fputs("usage: --render-icon out.png SIZE [--bleed]\n", stderr)
        exit(2)
    }
    let data = renderIcon(size: size, fullBleed: args.contains("--bleed"))
    try? data?.write(to: URL(fileURLWithPath: args[i + 1]))
    exit(data == nil ? 1 : 0)
}

if args.contains("--snapshot-island") || args.contains("--snapshot-alert") {
    let states = SnapshotState.allCases.map(\.rawValue).joined(separator: "|")
    guard let out = value(after: "--snapshot-island") ?? value(after: "--snapshot-alert"), !out.hasPrefix("--"),
          let state = SnapshotState(rawValue: value(after: "--state") ?? "task-red") else {
        fputs("usage: --snapshot-island out.png [--state \(states)] [--fake] [--real] [--appkit]\n", stderr)
        exit(2)
    }
    let ok = MainActor.assumeIsolated {
        renderSnapshot(state: state, to: out, fake: args.contains("--fake"), appKit: args.contains("--appkit"),
                       real: args.contains("--real"))
    }
    exit(ok ? 0 : 1)
}

if args.dropFirst().contains(where: { $0.hasPrefix("--") }) {
    fputs("unknown option. Dev flags: --snapshot-island, --render-icon\n", stderr)
    exit(2)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.appearance = NSAppearance(named: .darkAqua)
    withExtendedLifetime(delegate) { app.run() }
}
