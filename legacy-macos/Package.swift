// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClaudeUsageBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClaudeUsageBar",
            path: "Sources/ClaudeUsageBar",
            exclude: ["Info.plist", "ClaudeUsageBar.entitlements"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Sources/ClaudeUsageBar/Info.plist"])
            ]
        )
    ]
)
