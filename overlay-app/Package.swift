// swift-tools-version: 5.9
// A.T.L.A.S Native Overlay — No external dependencies

import PackageDescription

let package = Package(
    name: "ATLASOverlay",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ATLASOverlay",
            path: "Sources"
        )
    ]
)
