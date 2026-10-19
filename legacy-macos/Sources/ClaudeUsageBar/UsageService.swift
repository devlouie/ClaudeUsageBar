import Foundation

@MainActor
@Observable
final class UsageService {
    var usage: UsageResponse?
    var localCosts: LocalCostSummary = LocalCostSummary()
    var subscriptionType: String = ""
    var rateLimitTier: String = ""
    var lastUpdated: Date?
    var errorMessage: String?
    var isLoading = false
    var hasLoaded = false

    private var pollingTask: Task<Void, Never>?
    private var inflightRefresh: Task<Void, Never>?
    private var cachedToken: String?
    private var consecutiveErrors: Int = 0

    private static let basePollInterval: Duration = .seconds(60)
    private static let maxPollInterval: Duration = .seconds(15 * 60)

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        config.waitsForConnectivity = false
        config.httpAdditionalHeaders = ["User-Agent": "ClaudeUsageBar/1.0"]
        return URLSession(configuration: config)
    }()

    var sessionPercent: Double { clamp(usage?.fiveHour?.utilization) }
    var weeklyPercent: Double { clamp(usage?.sevenDay?.utilization) }

    var sessionElapsedPercent: Double {
        guard let resetStr = usage?.fiveHour?.resetsAt,
              let resetDate = parseResetTime(resetStr) else { return 0 }
        let windowSeconds: Double = 5 * 3600
        let remaining = resetDate.timeIntervalSinceNow
        guard remaining > 0 else { return 100 }
        let elapsed = windowSeconds - remaining
        return max(0, min(100, elapsed / windowSeconds * 100))
    }

    var planDisplayName: String {
        switch subscriptionType.lowercased() {
        case "max": return tierSuffix.isEmpty ? "Max" : tierSuffix
        case "pro": return "Pro"
        case "free": return "Free"
        default: return subscriptionType.isEmpty ? "Unknown" : subscriptionType.capitalized
        }
    }

    private var tierSuffix: String {
        if rateLimitTier.contains("20x") { return "Max 20x" }
        if rateLimitTier.contains("5x") { return "Max 5x" }
        return ""
    }

    func startPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                guard let self else { return }
                let delay = self.nextPollDelay()
                try? await Task.sleep(for: delay)
            }
        }
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
        inflightRefresh?.cancel()
        inflightRefresh = nil
    }

    private func nextPollDelay() -> Duration {
        guard consecutiveErrors > 0 else { return Self.basePollInterval }
        let exp = min(consecutiveErrors, 6)
        let backoffSeconds = min(
            Double(60) * pow(2.0, Double(exp - 1)),
            Double(15 * 60)
        )
        let jitter = Double.random(in: 0...min(5, backoffSeconds * 0.1))
        return .seconds(backoffSeconds + jitter)
    }

    func refresh(forceSource: Bool = false) async {
        if let existing = inflightRefresh {
            await existing.value
            return
        }
        let task: Task<Void, Never> = Task { [weak self] in
            await self?.performRefresh(forceSource: forceSource)
        }
        inflightRefresh = task
        await task.value
        inflightRefresh = nil
    }

    private func performRefresh(forceSource: Bool = false) async {
        isLoading = true
        defer { isLoading = false }

        if forceSource || cachedToken == nil { loadCredentials(forceSource: forceSource) }

        guard let token = cachedToken else {
            errorMessage = "No Claude Code credentials. Launch Claude Code first."
            consecutiveErrors += 1
            return
        }

        let sessionResetAt = parseResetTime(usage?.fiveHour?.resetsAt)
        let weeklyResetAt = parseResetTime(usage?.sevenDay?.resetsAt)
        async let apiOk: Bool = fetchUsage(token: token)
        async let logs: LocalCostSummary = Self.parseLocalLogs(
            sessionResetAt: sessionResetAt,
            weeklyResetAt: weeklyResetAt
        )

        let succeeded = await apiOk
        localCosts = await logs
        lastUpdated = Date()
        if succeeded {
            hasLoaded = true
            consecutiveErrors = 0
        } else {
            consecutiveErrors += 1
        }
    }

    private func loadCredentials(forceSource: Bool = false) {
        if !forceSource, let oauth = KeychainStore.readMirror(), isFresh(oauth) {
            applyCredentials(oauth)
            return
        }
        if let oauth = KeychainStore.readFromClaudeCode() {
            KeychainStore.writeMirror(oauth)
            applyCredentials(oauth)
            return
        }
        errorMessage = "No Claude Code credentials in Keychain"
        cachedToken = nil
    }

    private func applyCredentials(_ oauth: OAuthData) {
        cachedToken = oauth.accessToken
        subscriptionType = oauth.subscriptionType ?? ""
        rateLimitTier = oauth.rateLimitTier ?? ""
    }

    private func isFresh(_ oauth: OAuthData) -> Bool {
        guard let expiresAt = oauth.expiresAt else { return true }
        let expiry = Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000)
        return expiry.timeIntervalSinceNow > 60
    }

    @discardableResult
    private func fetchUsage(token: String) async -> Bool {
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else {
            errorMessage = "Invalid API URL"
            return false
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.timeoutInterval = 10

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                errorMessage = "Unexpected response"
                return false
            }

            switch http.statusCode {
            case 200..<300:
                do {
                    usage = try JSONDecoder().decode(UsageResponse.self, from: data)
                    errorMessage = nil
                    return true
                } catch {
                    errorMessage = "Could not parse usage data"
                    return false
                }
            case 401, 403:
                cachedToken = nil
                KeychainStore.deleteMirror()
                loadCredentials(forceSource: true)
                errorMessage = cachedToken == nil
                    ? "Token expired. Open Claude Code to sign in again."
                    : "Refreshed token; retrying on next tick."
                return false
            case 429:
                errorMessage = "Rate-limited by API. Retrying soon."
                return false
            case 500..<600:
                errorMessage = "Anthropic API unavailable (\(http.statusCode))."
                return false
            default:
                errorMessage = "API error (HTTP \(http.statusCode))"
                return false
            }
        } catch is CancellationError {
            return false
        } catch let urlError as URLError {
            errorMessage = urlError.code == .notConnectedToInternet
                ? "Offline"
                : "Network error: \(urlError.localizedDescription)"
            return false
        } catch {
            errorMessage = "API error: \(error.localizedDescription)"
            return false
        }
    }

    private static func parseLocalLogs(
        sessionResetAt: Date? = nil,
        weeklyResetAt: Date? = nil
    ) async -> LocalCostSummary {
        await Task.detached(priority: .utility) {
            let fm = FileManager.default
            let projectsURL = URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent(".claude/projects", isDirectory: true)

            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: projectsURL.path, isDirectory: &isDir), isDir.boolValue else {
                return LocalCostSummary()
            }

            let now = Date()
            let calendar = Calendar.current
            let startOfToday = calendar.startOfDay(for: now)
            let startOfWeek = calendar.date(from: calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)) ?? now
            let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) ?? now

            // Windows aligned to API resets (reset time − window length = window start).
            let sessionWindowStart = sessionResetAt?.addingTimeInterval(-5 * 3600)
            let weeklyWindowStart = weeklyResetAt?.addingTimeInterval(-7 * 24 * 3600)

            var summary = LocalCostSummary()
            let isoFormatter = ISO8601DateFormatter()
            isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let fallbackFormatter = ISO8601DateFormatter()
            fallbackFormatter.formatOptions = [.withInternetDateTime]

            guard let enumerator = fm.enumerator(
                at: projectsURL,
                includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { return summary }

            while let fileURL = enumerator.nextObject() as? URL {
                guard fileURL.pathExtension == "jsonl" else { continue }

                let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
                guard values?.isRegularFile == true,
                      let modDate = values?.contentModificationDate,
                      modDate >= startOfMonth else { continue }

                guard let data = try? Data(contentsOf: fileURL, options: [.mappedIfSafe]),
                      let content = String(data: data, encoding: .utf8) else { continue }

                for line in content.split(separator: "\n", omittingEmptySubsequences: true)
                    where line.contains("\"input_tokens\"") {
                    guard let lineData = line.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                          let type = json["type"] as? String, type == "assistant",
                          let message = json["message"] as? [String: Any],
                          let usageDict = message["usage"] as? [String: Any] else { continue }

                    let inputTokens = usageDict["input_tokens"] as? Int ?? 0
                    let outputTokens = usageDict["output_tokens"] as? Int ?? 0
                    let cacheRead = usageDict["cache_read_input_tokens"] as? Int ?? 0
                    let cacheWrite = usageDict["cache_creation_input_tokens"] as? Int ?? 0
                    let model = message["model"] as? String ?? "unknown"

                    guard let timestamp = json["timestamp"] as? String,
                          let date = isoFormatter.date(from: timestamp) ?? fallbackFormatter.date(from: timestamp),
                          date >= startOfMonth else { continue }

                    let cost = ModelPricing.cost(model: model, input: inputTokens, output: outputTokens, cacheRead: cacheRead, cacheWrite: cacheWrite)
                    let tokens = inputTokens + outputTokens + cacheRead + cacheWrite
                    let displayModel = ModelPricing.displayName(for: model)

                    summary.monthTokens += tokens
                    summary.monthCost += cost
                    summary.modelBreakdown[displayModel, default: 0] += cost

                    if date >= startOfWeek {
                        summary.weekTokens += tokens
                        summary.weekCost += cost
                    }
                    if date >= startOfToday {
                        summary.todayTokens += tokens
                        summary.todayCost += cost
                    }
                    if let start = sessionWindowStart, date >= start {
                        summary.sessionUsage.add(input: inputTokens, output: outputTokens, cacheRead: cacheRead, cacheWrite: cacheWrite)
                    }
                    if let start = weeklyWindowStart, date >= start {
                        summary.weeklyUsage.add(input: inputTokens, output: outputTokens, cacheRead: cacheRead, cacheWrite: cacheWrite)
                    }
                }
            }

            return summary
        }.value
    }

    private func clamp(_ value: Double?) -> Double {
        guard let value, value.isFinite else { return 0 }
        return max(0, min(100, value))
    }
}

extension UsageService {
    func parseResetTime(_ isoString: String?) -> Date? {
        guard let str = isoString, !str.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: str) { return d }
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        return f2.date(from: str)
    }

    func timeUntilReset(_ isoString: String?) -> String? {
        guard let date = parseResetTime(isoString) else { return nil }
        let interval = date.timeIntervalSinceNow
        guard interval > 0 else { return "resetting..." }

        let totalMinutes = Int(interval / 60)
        let days = totalMinutes / (60 * 24)
        let hours = (totalMinutes / 60) % 24
        let minutes = totalMinutes % 60

        if days > 0 {
            return hours > 0 ? "resets in \(days)d \(hours)h" : "resets in \(days)d"
        }
        if hours > 0 {
            return "resets in \(hours)h \(minutes)m"
        }
        return "resets in \(max(1, minutes))m"
    }
}
