// This Mac's identity in the network: its X25519 key and its device token. Both live only in the
// login Keychain, one item, never in a file, a log or an error message.
// The app writes it (pairing, unpairing); `Pingme mcp` only reads it.

import Foundation
import Security

struct DeviceIdentity: Codable, Equatable {
    var v = 1
    /// Raw 32-byte X25519 private key, standard base64.
    var privateKey: String
    /// Nil while a pairing is still waiting for approval.
    var token: String?
    var deviceId: String?
    var userId: String?
    /// The account's name ("Michal").
    var name: String?

    var paired: Bool { token != nil && deviceId != nil && userId != nil }

    func key() throws -> Seal.PrivateKey { try Seal.importPrivateKey(privateKey) }
}

enum KeychainError: Error, Equatable {
    /// The user denied access, or macOS could not ask (a rebuilt binary meets the old item's ACL).
    case denied(OSStatus)
    case failed(OSStatus)
    case corrupt

    var message: String {
        switch self {
        case .denied: return "pingme can't access its key in Keychain."
        case .failed(let s): return "Keychain returned error \(s)."
        case .corrupt: return "The key in Keychain is damaged."
        }
    }
}

enum IdentityStore {
    /// Selftests point this at a throwaway service (env PINGME_KEYCHAIN_SERVICE), so they never see the real item.
    static var service = ProcessInfo.processInfo.environment["PINGME_KEYCHAIN_SERVICE"]
        .flatMap { $0.isEmpty ? nil : $0 } ?? "cz.dominik.pingme"
    static let account = "device"

    private static func base() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func classify(_ status: OSStatus) -> KeychainError {
        switch status {
        case errSecAuthFailed, errSecUserCanceled, errSecInteractionNotAllowed, errSecNoAccessForItem:
            return .denied(status)
        default:
            return .failed(status)
        }
    }

    /// Nil means "not paired": there is no item. Any other problem is an error, never "not paired",
    /// so a denied Keychain prompt cannot make the app throw its identity away.
    static func load() -> Result<DeviceIdentity?, KeychainError> {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return .success(nil) }
        guard status == errSecSuccess else { return .failure(classify(status)) }
        guard let data = out as? Data, let id = try? JSONDecoder().decode(DeviceIdentity.self, from: data) else {
            return .failure(.corrupt)
        }
        return .success(id)
    }

    static func save(_ id: DeviceIdentity) throws {
        let data = try JSONEncoder().encode(id)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base() as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw classify(status) }
        var add = base()
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "pingme"
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw classify(added) }
    }

    static func delete() throws {
        let status = SecItemDelete(base() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw classify(status) }
    }
}
