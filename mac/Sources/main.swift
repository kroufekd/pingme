// pingme for Mac: one device in the pingme network.
// Tasks are stored only here, on the Mac. Contacts (web or their Macs) and agents (local MCP) send
// end-to-end encrypted pings through the server; the Mac picks them up over a live Convex feed, acks
// them through /device/sync and reports statuses and sealed replies back.
// Everything shows in one island at the notch: a due task, a new task, what waits, people and pairing.
// `Pingme mcp` is the local MCP server for coding agents (MCPServer.swift).

import AppKit

let args = CommandLine.arguments

func value(after flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// The MCP server never touches AppKit: stdin, stdout, the Keychain and the network only.
if args.count >= 2 && args[1] == "mcp" {
    exit(MCPServer.run())
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
        fputs("usage: --snapshot-island out.png [--state \(states)] [--fake] [--real] [--appkit] [--fly 0...1]\n", stderr)
        exit(2)
    }
    let ok = MainActor.assumeIsolated {
        renderSnapshot(state: state, to: out, fake: args.contains("--fake"), appKit: args.contains("--appkit"),
                       real: args.contains("--real"), fly: value(after: "--fly").flatMap(Double.init))
    }
    exit(ok ? 0 : 1)
}

if args.contains("--selftest-crypto") {
    let path = value(after: "--selftest-crypto").flatMap { $0.hasPrefix("--") ? nil : $0 }
    exit(Selftest.crypto(path: path, emit: value(after: "--emit")) ? 0 : 1)
}

if args.contains("--selftest-network") {
    exit(MainActor.assumeIsolated { Selftest.network() } ? 0 : 1)
}

if args.contains("--selftest-mcp") {
    exit(Selftest.mcp() ? 0 : 1)
}

if args.contains("--selftest-keychain") {
    exit(Selftest.keychain() ? 0 : 1)
}

if args.dropFirst().contains(where: { $0.hasPrefix("--") }) {
    fputs("unknown option. Commands: mcp. Dev flags: --snapshot-island, --render-icon, --selftest-crypto, "
        + "--selftest-network, --selftest-mcp, --selftest-keychain\n", stderr)
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
