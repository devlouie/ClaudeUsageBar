import SwiftUI

// Type scale: title3 → subheadline → caption → caption2
// Weights: semibold (metrics), medium (labels), regular (body)
// Colors: .primary, .secondary, statusColor(). Nothing else

struct ContentView: View {
    @Environment(UsageService.self) private var service
    @State private var showDetails = false
    @AppStorage("didExplainKeychainPrompt") private var didExplainKeychainPrompt = false

    var body: some View {
        VStack(spacing: 0) {
            if service.errorMessage != nil && service.usage == nil {
                errorState
            } else if !service.hasLoaded {
                loadingState
            } else {
                urgencyBanner
                if !didExplainKeychainPrompt {
                    firstRunExplainer
                }
                if service.errorMessage != nil {
                    staleBanner
                }
                sessionSection
                    .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 10)
                divider
                weeklySection
                    .padding(.horizontal, 16).padding(.vertical, 10)
                divider
                detailsSection
                    .padding(.horizontal, 16).padding(.vertical, 10)
                divider
                footer
                    .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
        .frame(width: 300)
    }

    private var firstRunExplainer: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "lock.shield")
            VStack(alignment: .leading, spacing: 4) {
                Text("macOS may ask to access Claude Code's login")
                    .fontWeight(.medium)
                Text("Click \"Always Allow\" and you won't see it again.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Got it") { didExplainKeychainPrompt = true }
                .buttonStyle(.borderless)
                .font(.caption2)
        }
        .font(.caption2)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.08))
    }

    private var staleBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.exclamationmark")
            Text(service.errorMessage ?? "Update failed")
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.08))
    }

    private var divider: some View {
        Divider().padding(.horizontal, 16)
    }

    // MARK: - Banner

    @ViewBuilder
    private var urgencyBanner: some View {
        let pct = service.sessionPercent
        if pct >= 80 {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(pct >= 95 ? "Session almost exhausted" : "Approaching session limit")
                Spacer()
                if let reset = service.timeUntilReset(service.usage?.fiveHour?.resetsAt) {
                    Text(reset)
                        .fontWeight(.semibold)
                }
            }
            .font(.caption)
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(pct >= 95 ? AnyShapeStyle(.red.gradient) : AnyShapeStyle(.orange.gradient))
        }
    }

    // MARK: - Session (hero)

    private var sessionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Session")
                    .font(.subheadline)
                    .fontWeight(.medium)
                Spacer()
                Text(pct(service.sessionPercent))
                    .font(.title3)
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .foregroundStyle(statusColor(service.sessionPercent))
            }
            VStack(spacing: 3) {
                UsageBar(percent: service.sessionPercent)
                ResetBar(elapsed: service.sessionElapsedPercent)
            }
            HStack {
                if let reset = service.timeUntilReset(service.usage?.fiveHour?.resetsAt) {
                    Text(reset.capitalized)
                }
                Spacer()
                if service.sessionPercent > service.sessionElapsedPercent {
                    Text("Burning fast")
                        .foregroundStyle(statusColor(service.sessionPercent))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Weekly (secondary)

    private var weeklySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Weekly")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(pct(service.weeklyPercent))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .foregroundStyle(statusColor(service.weeklyPercent))
                if let reset = service.timeUntilReset(service.usage?.sevenDay?.resetsAt) {
                    Text("·").foregroundStyle(.secondary)
                    Text(reset)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            UsageBar(percent: service.weeklyPercent, height: 4)
        }
    }

    // MARK: - Details (progressive disclosure)

    private var detailsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { showDetails.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(showDetails ? 90 : 0))
                    Text("Details")
                    Spacer()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showDetails {
                VStack(spacing: 6) {
                    detailRows
                }
                .padding(.top, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @ViewBuilder
    private var detailRows: some View {
        if let sonnet = service.usage?.sevenDaySonnet?.utilization, sonnet > 0 {
            DetailRow(label: "Sonnet (7d)", value: pct(sonnet),
                      valueColor: statusColor(sonnet))
        }
        if let opus = service.usage?.sevenDayOpus?.utilization, opus > 0 {
            DetailRow(label: "Opus (7d)", value: pct(opus),
                      valueColor: statusColor(opus))
        }

        let extra = service.usage?.extraUsage
        if extra?.isEnabled == true, let used = extra?.usedCredits, let limit = extra?.monthlyLimit {
            DetailRow(label: "Extra usage",
                      value: String(format: "$%.2f / $%.2f", used, limit))
        } else {
            DetailRow(label: "Extra usage", value: "Off")
        }

        Divider().padding(.vertical, 2)

        let session = service.localCosts.sessionUsage
        if session.totalTokens > 0 {
            DetailRow(label: "Session (in / out)",
                      value: "\(tok(session.inputTokens + session.cacheReadTokens + session.cacheCreationTokens)) / \(tok(session.outputTokens))")
        }
        let weekly = service.localCosts.weeklyUsage
        if weekly.totalTokens > 0 {
            DetailRow(label: "Weekly (in / out)",
                      value: "\(tok(weekly.inputTokens + weekly.cacheReadTokens + weekly.cacheCreationTokens)) / \(tok(weekly.outputTokens))")
        }

        DetailRow(label: "Today", value: tok(service.localCosts.todayTokens))
        DetailRow(label: "This week", value: tok(service.localCosts.weekTokens))
        DetailRow(label: "This month", value: tok(service.localCosts.monthTokens))

        if !service.localCosts.modelBreakdown.isEmpty {
            Divider().padding(.vertical, 2)
            ForEach(service.localCosts.modelBreakdown.sorted(by: { $0.value > $1.value }), id: \.key) { model, cost in
                HStack(spacing: 6) {
                    Circle().fill(modelColor(model)).frame(width: 5, height: 5)
                    Text(model).foregroundStyle(.secondary)
                    Spacer()
                    Text(String(format: "$%.2f eq.", cost))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 8) {
            Text(service.planDisplayName)
                .foregroundStyle(.purple)
            Spacer()
            if let updated = service.lastUpdated {
                HStack(spacing: 2) {
                    Text(updated, style: .relative)
                    Text("ago")
                }
                .foregroundStyle(.secondary)
            }
            Button(action: { Task { await service.refresh() } }) {
                Image(systemName: "arrow.clockwise")
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(service.isLoading ? 360 : 0))
                    .animation(
                        service.isLoading
                        ? .linear(duration: 0.8).repeatForever(autoreverses: false)
                        : .default,
                        value: service.isLoading
                    )
            }
            .buttonStyle(.plain)
            .help("Refresh")
            Button(action: { NSApplication.shared.terminate(nil) }) {
                Image(systemName: "xmark")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Quit")
        }
        .font(.caption2)
    }

    // MARK: - Loading / Error

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(0.7)
            Text("Loading usage data...")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }

    private var errorState: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(.orange)
            Text(service.errorMessage ?? "Unknown error")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("Open Claude Code to sign in, then retry.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("Retry") { Task { await service.refresh() } }
                    .font(.caption)
                    .buttonStyle(.bordered)
                Button("Re-read from Claude Code") {
                    Task { await service.refresh(forceSource: true) }
                }
                .font(.caption)
                .buttonStyle(.bordered)
                .help("Re-reads Claude Code's keychain item (may prompt once)")
            }
        }
        .padding(24)
    }
}

// MARK: - Components

struct UsageBar: View {
    let percent: Double
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height / 2)
                    .fill(.quaternary)
                RoundedRectangle(cornerRadius: height / 2)
                    .fill(statusColor(percent).gradient)
                    .frame(width: max(0, geo.size.width * min(percent / 100, 1.0)))
                    .animation(.easeInOut(duration: 0.5), value: percent)
            }
        }
        .frame(height: height)
    }
}

struct ResetBar: View {
    let elapsed: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.blue.opacity(0.1))
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.blue.opacity(0.35))
                    .frame(width: max(0, geo.size.width * min(elapsed / 100, 1.0)))
                    .animation(.easeInOut(duration: 0.5), value: elapsed)
            }
        }
        .frame(height: 3)
    }
}

struct DetailRow: View {
    let label: String
    let value: String
    var valueColor: Color = .primary

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .monospacedDigit()
                .foregroundStyle(valueColor)
        }
        .font(.caption)
    }
}

// MARK: - Helpers

func statusColor(_ percent: Double) -> Color {
    if percent >= 80 { return .red }
    if percent >= 50 { return .orange }
    return .green
}

func modelColor(_ model: String) -> Color {
    switch model {
    case "Opus": return .purple
    case "Sonnet": return .blue
    case "Haiku": return .cyan
    default: return .gray
    }
}

private func pct(_ value: Double) -> String {
    String(format: "%.0f%%", value)
}

private func tok(_ count: Int) -> String {
    if count >= 1_000_000 { return String(format: "%.1fM tok", Double(count) / 1_000_000) }
    if count >= 1_000 { return String(format: "%.0fK tok", Double(count) / 1_000) }
    return "\(count) tok"
}
