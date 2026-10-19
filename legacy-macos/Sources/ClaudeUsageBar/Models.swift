import Foundation

struct UsageResponse: Codable {
    let fiveHour: UsageWindow?
    let sevenDay: UsageWindow?
    let sevenDayOauthApps: UsageWindow?
    let sevenDayOpus: UsageWindow?
    let sevenDaySonnet: UsageWindow?
    let sevenDayCowork: UsageWindow?
    let sevenDayOmelette: UsageWindow?
    let iguanaNecktie: UsageWindow?
    let extraUsage: ExtraUsage?

    enum CodingKeys: String, CodingKey {
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
        case sevenDayOauthApps = "seven_day_oauth_apps"
        case sevenDayOpus = "seven_day_opus"
        case sevenDaySonnet = "seven_day_sonnet"
        case sevenDayCowork = "seven_day_cowork"
        case sevenDayOmelette = "seven_day_omelette"
        case iguanaNecktie = "iguana_necktie"
        case extraUsage = "extra_usage"
    }
}

struct UsageWindow: Codable {
    let utilization: Double?
    let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }
}

struct ExtraUsage: Codable {
    let isEnabled: Bool?
    let monthlyLimit: Double?
    let usedCredits: Double?
    let utilization: Double?

    enum CodingKeys: String, CodingKey {
        case isEnabled = "is_enabled"
        case monthlyLimit = "monthly_limit"
        case usedCredits = "used_credits"
        case utilization
    }
}

struct KeychainCredentials: Codable {
    let claudeAiOauth: OAuthData?
}

struct OAuthData: Codable {
    let accessToken: String
    let refreshToken: String?
    let expiresAt: Int64?
    let subscriptionType: String?
    let rateLimitTier: String?
}

struct TokenUsage: Sendable {
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var cacheReadTokens: Int = 0
    var cacheCreationTokens: Int = 0

    var totalTokens: Int {
        inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
    }

    mutating func add(input: Int, output: Int, cacheRead: Int, cacheWrite: Int) {
        inputTokens += input
        outputTokens += output
        cacheReadTokens += cacheRead
        cacheCreationTokens += cacheWrite
    }
}

struct LocalCostSummary: Sendable {
    var todayTokens: Int = 0
    var todayCost: Double = 0
    var weekTokens: Int = 0
    var weekCost: Double = 0
    var monthTokens: Int = 0
    var monthCost: Double = 0
    var modelBreakdown: [String: Double] = [:]

    // Windows aligned to API rate-limit resets (populated when API reset times are known).
    var sessionUsage: TokenUsage = TokenUsage()   // last 5h (fiveHour window)
    var weeklyUsage: TokenUsage = TokenUsage()    // last 7d (sevenDay window)
}

enum ModelPricing {
    static func cost(model: String, input: Int, output: Int, cacheRead: Int, cacheWrite: Int) -> Double {
        let (inp, outp, cr, cw) = rates(for: model)
        return Double(input) / 1_000_000 * inp
             + Double(output) / 1_000_000 * outp
             + Double(cacheRead) / 1_000_000 * cr
             + Double(cacheWrite) / 1_000_000 * cw
    }

    private static func rates(for model: String) -> (Double, Double, Double, Double) {
        if model.contains("opus") {
            return (5.0, 25.0, 0.5, 6.25)
        } else if model.contains("haiku") {
            return (1.0, 5.0, 0.1, 1.25)
        } else {
            return (3.0, 15.0, 0.3, 3.75)
        }
    }

    static func displayName(for model: String) -> String {
        if model.contains("opus") { return "Opus" }
        if model.contains("haiku") { return "Haiku" }
        if model.contains("sonnet") { return "Sonnet" }
        return model
    }
}
