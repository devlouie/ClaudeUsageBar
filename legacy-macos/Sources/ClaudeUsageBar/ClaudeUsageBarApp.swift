import SwiftUI

@main
struct ClaudeUsageBarApp: App {
    @State private var service = UsageService()

    var body: some Scene {
        MenuBarExtra {
            ContentView()
                .environment(service)
        } label: {
            menuBarLabel
        }
        .menuBarExtraStyle(.window)
    }

    // NN/g H1 (system status): the menu bar icon answers
    // "am I close to being rate-limited?" at a glance.
    // Color carries urgency; number carries precision.
    private var menuBarLabel: some View {
        HStack(spacing: 3) {
            Image(systemName: statusIcon)
                .font(.system(size: 9))
                .foregroundStyle(statusColor(worst.percent))
            Text(menuBarText)
                .font(.system(size: 11, weight: .medium))
                .monospacedDigit()
            if burning {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(statusColor(worst.percent))
            }
        }
        .help(tooltip)
        .task {
            service.startPolling()
        }
    }

    private struct WorstWindow {
        let tag: String
        let percent: Double
    }

    private var worst: WorstWindow {
        let session = service.sessionPercent
        let weekly = service.weeklyPercent
        let opus = service.usage?.sevenDayOpus?.utilization ?? 0
        let candidates: [(String, Double)] = [("S", session), ("W", weekly), ("O", opus)]
        let top = candidates.max(by: { $0.1 < $1.1 }) ?? ("S", session)
        return WorstWindow(tag: top.0, percent: top.1)
    }

    private var burning: Bool {
        worst.tag == "S" && service.sessionPercent > service.sessionElapsedPercent + 10
    }

    private var statusIcon: String {
        let pct = worst.percent
        if pct >= 80 { return "exclamationmark.circle.fill" }
        if pct >= 50 { return "circle.lefthalf.filled" }
        return "circle.fill"
    }

    private var menuBarText: String {
        guard service.hasLoaded else { return "--" }
        return String(format: "%.0f%% %@", worst.percent, worst.tag)
    }

    private var tooltip: String {
        guard service.hasLoaded else { return "Loading…" }
        var parts = [
            String(format: "Session: %.0f%%", service.sessionPercent),
            String(format: "Weekly: %.0f%%", service.weeklyPercent)
        ]
        if let opus = service.usage?.sevenDayOpus?.utilization, opus > 0 {
            parts.append(String(format: "Opus (7d): %.0f%%", opus))
        }
        return parts.joined(separator: " · ")
    }
}
