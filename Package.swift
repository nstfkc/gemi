// swift-tools-version: 6.0

// The Swift client for gemi agents, `useChat` for iOS.
//
// The manifest is at the repository root because that is the only place
// SwiftPM looks for one: an app adds this repository's URL and gets the
// package, versioned by the repository's own `vX.Y.Z` tags — which are gemi's
// tags, so a client release is always the protocol release it speaks. The
// sources live in `packages/gemi-swift`, beside the npm packages.

import PackageDescription

let package = Package(
  name: "GemiChat",
  // iOS 17 for `@Observable`. macOS only so `swift test` runs on a Mac without
  // a simulator; nothing here is iOS-specific.
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "GemiChat", targets: ["GemiChat"])
  ],
  targets: [
    .target(name: "GemiChat", path: "packages/gemi-swift/Sources/GemiChat"),
    .testTarget(
      name: "GemiChatTests",
      dependencies: ["GemiChat"],
      path: "packages/gemi-swift/Tests/GemiChatTests"
    ),
  ]
)
