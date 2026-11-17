// End-to-end encryption for pingme v1. The server only relays what this file produces.
//
// HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, info "pingme v1".
// The web twin is web/src/lib/seal.ts; shared/hpke-vectors.json proves both sides agree
// (`Pingme --selftest-crypto`). Keys are raw 32-byte X25519 values, standard base64 on the wire.
// Storing the private key (Keychain) is the caller's job: use `rawRepresentation`.

import CryptoKit
import Foundation

enum Seal {
    static let info = "pingme v1"
    static let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .chaChaPoly)

    typealias PrivateKey = Curve25519.KeyAgreement.PrivateKey

    enum Kind: String { case title, reply }

    /// Output of `seal`, base64.
    struct Sealed: Codable, Equatable {
        var enc: String
        var ct: String
    }

    /// One sealed copy per target device.
    struct Envelope: Codable, Equatable {
        var deviceId: String
        var enc: String
        var ct: String
    }

    enum Failure: Error, Equatable {
        case badBase64(String)
        case badLength(String)
        case badField(String)
        case cannotOpen
        case notUTF8
    }

    /// New device key pair. Keep the private key in Keychain, publish `publicKey`.
    static func generateKeyPair() -> (publicKey: String, privateKey: PrivateKey) {
        let sk = PrivateKey()
        return (publicKey(of: sk), sk)
    }

    static func publicKey(of privateKey: PrivateKey) -> String {
        privateKey.publicKey.rawRepresentation.base64EncodedString()
    }

    static func exportPrivateKey(_ key: PrivateKey) -> String {
        key.rawRepresentation.base64EncodedString()
    }

    static func importPrivateKey(_ base64: String) throws -> PrivateKey {
        try PrivateKey(rawRepresentation: decodeKey(base64, "privateKey"))
    }

    /// Encrypts plaintext (UTF-8) for one recipient public key. Every call uses a fresh ephemeral key.
    static func seal(publicKey: String, plaintext: String, aad: Data) throws -> Sealed {
        let pk = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: decodeKey(publicKey, "publicKey"))
        var sender = try HPKE.Sender(recipientKey: pk, ciphersuite: suite, info: Data(info.utf8))
        let ct = try sender.seal(Data(plaintext.utf8), authenticating: aad)
        return Sealed(enc: sender.encapsulatedKey.base64EncodedString(), ct: ct.base64EncodedString())
    }

    /// Decrypts. Throws on a wrong key, wrong AAD or any tampering; never returns partial text.
    static func open(privateKey: PrivateKey, _ sealed: Sealed, aad: Data) throws -> String {
        try open(privateKey: privateKey, sealed, aad: aad, info: Data(info.utf8))
    }

    /// Explicit `info`: the RFC 9180 known-answer test and the pairing token ("pingme pair v1"). Pings use the overload above.
    static func open(privateKey: PrivateKey, _ sealed: Sealed, aad: Data, info: Data) throws -> String {
        let enc = try decodeKey(sealed.enc, "enc")
        let ct = try decode(sealed.ct, "ct")
        let pt: Data
        do {
            var recipient = try HPKE.Recipient(privateKey: privateKey, ciphersuite: suite, info: info,
                                               encapsulatedKey: enc)
            pt = try recipient.open(ct, authenticating: aad)
        } catch {
            throw Failure.cannotOpen
        }
        guard let text = String(data: pt, encoding: .utf8) else { throw Failure.notUTF8 }
        return text
    }

    /// Seals the same plaintext once per device, in the shape the server stores.
    static func sealEnvelopes(_ devices: [(deviceId: String, publicKey: String)], plaintext: String,
                              aad: Data) throws -> [Envelope] {
        try devices.map {
            let s = try seal(publicKey: $0.publicKey, plaintext: plaintext, aad: aad)
            return Envelope(deviceId: $0.deviceId, enc: s.enc, ct: s.ct)
        }
    }

    /// "pingme v1|kind|ref|from|to" as UTF-8. Binds the ciphertext to its message and both users,
    /// so the server cannot move a sealed text to another task or person.
    static func aad(kind: Kind, ref: String, from: String, to: String) throws -> Data {
        // "|" is the separator, so a field containing it could forge another field's boundary.
        // Checked on UTF-8 bytes, like the web, so a combining mark after "|" cannot hide it.
        for (name, v) in [("ref", ref), ("from", from), ("to", to)] where v.isEmpty || v.utf8.contains(UInt8(ascii: "|")) {
            throw Failure.badField(name)
        }
        return Data("\(info)|\(kind.rawValue)|\(ref)|\(from)|\(to)".utf8)
    }

    /// Fresh task reference: 16 random bytes, base64url without padding (22 chars).
    static func newRef() -> String {
        let bytes = SymmetricKey(size: .bits128).withUnsafeBytes { Data($0) }
        return bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decode(_ s: String, _ what: String) throws -> Data {
        guard let d = Data(base64Encoded: s) else { throw Failure.badBase64(what) }
        return d
    }

    private static func decodeKey(_ s: String, _ what: String) throws -> Data {
        let d = try decode(s, what)
        guard d.count == 32 else { throw Failure.badLength(what) }
        return d
    }
}
