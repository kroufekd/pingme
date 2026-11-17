// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Pingme",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/get-convex/convex-swift", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "Pingme",
            dependencies: [.product(name: "ConvexMobile", package: "convex-swift")],
            path: "Sources"),
    ]
)
