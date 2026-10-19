import Foundation
import Security

enum KeychainStore {
    static let mirrorService = "com.local.ClaudeUsageBar-credentials"
    static let mirrorAccount = "oauth"
    static let sourceService = "Claude Code-credentials"

    static func readMirror() -> OAuthData? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: mirrorService,
            kSecAttrAccount as String: mirrorAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseDataProtectionKeychain as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(OAuthData.self, from: data)
    }

    @discardableResult
    static func writeMirror(_ oauth: OAuthData) -> OSStatus {
        guard let data = try? JSONEncoder().encode(oauth) else { return errSecParam }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: mirrorService,
            kSecAttrAccount as String: mirrorAccount,
            kSecUseDataProtectionKeychain as String: true
        ]
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return status }
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(add as CFDictionary, nil)
        }
        return status
    }

    static func deleteMirror() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: mirrorService,
            kSecAttrAccount as String: mirrorAccount,
            kSecUseDataProtectionKeychain as String: true
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func readFromClaudeCode() -> OAuthData? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: sourceService,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let creds = try? JSONDecoder().decode(KeychainCredentials.self, from: data)
        else { return nil }
        return creds.claudeAiOauth
    }
}
