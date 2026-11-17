// `Pingme --selftest-crypto [vectors.json] [--emit out.json]`
// Proves Seal.swift against RFC 9180 and against what the web (seal.ts) produced, then seals fresh ones.
// Exit code 0 only if every check passed. Vectors default to ../shared/hpke-vectors.json (run from mac/).
// --emit writes Swift-made vectors for keys.ts; paste them into "fromSwift" by hand. Tests never rewrite
// the vectors file, so a broken side cannot silently regenerate its own proof.

import Foundation

enum Selftest {
    struct KeyPair: Decodable {
        var publicKey: String
        var privateKey: String
    }

    struct Vector: Codable {
        var kind: String
        var ref: String
        var from: String
        var to: String
        var plaintext: String
        var enc: String
        var ct: String
    }

    /// RFC 9180 A.2.1, sequence number 0, hex.
    struct Rfc: Decodable {
        var skRm, pkRm, info, enc, aad, pt, ct: String
    }

    /// Pairing: the 6-digit code, and a device token sealed by the web (server) side for keys.swift.
    struct PairCode: Decodable { var pairId, publicKey, code: String }
    struct PairToken: Decodable { var info, pairId, userId, token, enc, ct: String }

    struct Vectors: Decodable {
        var info: String
        var keys: [String: KeyPair]
        var rfc9180: Rfc
        var fromTs: [Vector]
        var fromSwift: [Vector]
        var pairCode: PairCode
        var pairToken: PairToken
    }

    /// Plaintexts both sides seal when emitting: plain, Czech diacritics with emoji, a reply, empty.
    static let samples: [(Seal.Kind, String)] = [
        (.title, "Zavolej mi, až budeš mít chvilku."),
        (.title, "Příliš žluťoučký kůň úpěl ďábelské ódy 🐴"),
        (.reply, "Hotovo, díky!"),
        (.reply, ""),
    ]

    static func crypto(path: String?, emit: String?) -> Bool {
        var passed = 0, failed = 0
        func check(_ name: String, _ ok: @autoclosure () throws -> Bool) {
            do {
                if try ok() { passed += 1; print("ok   \(name)") } else { failed += 1; print("FAIL \(name)") }
            } catch {
                failed += 1
                print("FAIL \(name): \(error)")
            }
        }
        func throwsError(_ body: () throws -> Any) -> Bool {
            do { _ = try body(); return false } catch { return true }
        }

        let candidates = path.map { [$0] } ?? ["../shared/hpke-vectors.json", "shared/hpke-vectors.json"]
        guard let file = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }),
              let data = FileManager.default.contents(atPath: file) else {
            print("FAIL vectors not found (tried \(candidates.joined(separator: ", ")))")
            return false
        }
        let v: Vectors
        do { v = try JSONDecoder().decode(Vectors.self, from: data) } catch {
            print("FAIL cannot parse \(file): \(error)")
            return false
        }
        guard let tsPair = v.keys["ts"], let swiftPair = v.keys["swift"],
              let tsKey = try? Seal.importPrivateKey(tsPair.privateKey),
              let swiftKey = try? Seal.importPrivateKey(swiftPair.privateKey) else {
            print("FAIL keys.ts and keys.swift must hold valid 32-byte keys")
            return false
        }
        print("vectors: \(file)")

        // 1. The suite itself, against the RFC's published answer.
        let rfc = v.rfc9180
        check("rfc9180 A.2.1 public key from private key", try {
            try Seal.publicKey(of: Seal.PrivateKey(rawRepresentation: hex(rfc.skRm))) == hex(rfc.pkRm).base64EncodedString()
        }())
        check("rfc9180 A.2.1 open seq 0", try {
            let sk = try Seal.PrivateKey(rawRepresentation: hex(rfc.skRm))
            let sealed = try Seal.Sealed(enc: hex(rfc.enc).base64EncodedString(), ct: hex(rfc.ct).base64EncodedString())
            let pt = try Seal.open(privateKey: sk, sealed, aad: hex(rfc.aad), info: hex(rfc.info))
            return try Data(pt.utf8) == hex(rfc.pt)
        }())

        // 2. Fixtures agree with this code.
        check("info is \"\(Seal.info)\"", v.info == Seal.info)
        check("keys.ts public key matches its private key", Seal.publicKey(of: tsKey) == tsPair.publicKey)
        check("keys.swift public key matches its private key", Seal.publicKey(of: swiftKey) == swiftPair.publicKey)

        // 3. Web-made vectors open here; own vectors still open; wrong AAD or key never does.
        func openAll(_ list: [Vector], _ label: String, key: Seal.PrivateKey, wrongKey: Seal.PrivateKey) {
            check("\(label): has both kinds", Set(list.map(\.kind)) == ["title", "reply"])
            for (i, x) in list.enumerated() {
                let name = "\(label)[\(i)] \(x.kind)"
                guard let kind = Seal.Kind(rawValue: x.kind) else { check("\(name): known kind", false); continue }
                let other: Seal.Kind = kind == .title ? .reply : .title
                let sealed = Seal.Sealed(enc: x.enc, ct: x.ct)
                check("\(name): opens", try {
                    try Seal.open(privateKey: key, sealed, aad: Seal.aad(kind: kind, ref: x.ref, from: x.from, to: x.to))
                        == x.plaintext
                }())
                check("\(name): wrong kind fails", throwsError {
                    try Seal.open(privateKey: key, sealed, aad: Seal.aad(kind: other, ref: x.ref, from: x.from, to: x.to))
                })
                check("\(name): swapped users fail", throwsError {
                    try Seal.open(privateKey: key, sealed, aad: Seal.aad(kind: kind, ref: x.ref, from: x.to, to: x.from))
                })
                check("\(name): other ref fails", throwsError {
                    try Seal.open(privateKey: key, sealed, aad: Seal.aad(kind: kind, ref: Seal.newRef(), from: x.from,
                                                                         to: x.to))
                })
                check("\(name): wrong key fails", throwsError {
                    try Seal.open(privateKey: wrongKey, sealed, aad: Seal.aad(kind: kind, ref: x.ref, from: x.from,
                                                                              to: x.to))
                })
            }
        }
        openAll(v.fromTs, "fromTs", key: swiftKey, wrongKey: tsKey)
        openAll(v.fromSwift, "fromSwift", key: tsKey, wrongKey: swiftKey)

        // 3b. Pairing: same code as the server, and the token sealed by TS opens only as a pairing token.
        check("pair code matches the server vector",
              Net.pairCode(pairId: v.pairCode.pairId, publicKey: v.pairCode.publicKey) == v.pairCode.code)
        check("pair code is 6 digits", Net.pairCode(pairId: "x", publicKey: "y").range(of: "^[0-9]{6}$",
                                                                                         options: .regularExpression) != nil)
        let pt = v.pairToken
        let ptSealed = Seal.Sealed(enc: pt.enc, ct: pt.ct)
        check("pair token info is the contract string", pt.info == Net.pairInfo)
        check("pair token from TS opens", try Net.openPairToken(ptSealed, privateKey: swiftKey, pairId: pt.pairId,
                                                                userId: pt.userId) == pt.token)
        check("pair token: other user fails", throwsError {
            try Net.openPairToken(ptSealed, privateKey: swiftKey, pairId: pt.pairId, userId: pt.userId + "x")
        })
        check("pair token: other pair id fails", throwsError {
            try Net.openPairToken(ptSealed, privateKey: swiftKey, pairId: "B" + pt.pairId.dropFirst(), userId: pt.userId)
        })
        check("pair token: wrong key fails", throwsError {
            try Net.openPairToken(ptSealed, privateKey: tsKey, pairId: pt.pairId, userId: pt.userId)
        })
        check("pair token never opens as a ping", throwsError {
            try Seal.open(privateKey: swiftKey, ptSealed, aad: Data("\(Net.pairInfo)|\(pt.pairId)|\(pt.userId)".utf8))
        })
        check("pair token rejects | in fields", throwsError {
            try Net.openPairToken(ptSealed, privateKey: swiftKey, pairId: "a|b", userId: pt.userId)
        })

        // 4. Fresh seals: round trip, tampering, AAD rules.
        let fresh = Seal.generateKeyPair()
        check("generated key is 32 bytes", Data(base64Encoded: fresh.publicKey)?.count == 32)
        check("private key export and import keep the key", try {
            Seal.publicKey(of: try Seal.importPrivateKey(Seal.exportPrivateKey(fresh.privateKey))) == fresh.publicKey
        }())
        let aad = try? Seal.aad(kind: .title, ref: Seal.newRef(), from: "u_mac_test", to: "u_web_test")
        check("aad builds", aad != nil)
        if let aad {
            check("round trip", try {
                let s = try Seal.seal(publicKey: fresh.publicKey, plaintext: "Ahoj 👋", aad: aad)
                return try Seal.open(privateKey: fresh.privateKey, s, aad: aad) == "Ahoj 👋"
            }())
            check("same text seals differently each time", try {
                try Seal.seal(publicKey: fresh.publicKey, plaintext: "x", aad: aad)
                    != Seal.seal(publicKey: fresh.publicKey, plaintext: "x", aad: aad)
            }())
            check("wrong aad fails", throwsError {
                let s = try Seal.seal(publicKey: fresh.publicKey, plaintext: "x", aad: aad)
                return try Seal.open(privateKey: fresh.privateKey, s, aad: aad + Data([0]))
            })
            check("wrong key fails", throwsError {
                let s = try Seal.seal(publicKey: fresh.publicKey, plaintext: "x", aad: aad)
                return try Seal.open(privateKey: Seal.PrivateKey(), s, aad: aad)
            })
            check("tampered ct fails", throwsError {
                var s = try Seal.seal(publicKey: fresh.publicKey, plaintext: "x", aad: aad)
                s.ct = flipFirstBit(s.ct)
                return try Seal.open(privateKey: fresh.privateKey, s, aad: aad)
            })
            check("tampered enc fails", throwsError {
                var s = try Seal.seal(publicKey: fresh.publicKey, plaintext: "x", aad: aad)
                s.enc = flipFirstBit(s.enc)
                return try Seal.open(privateKey: fresh.privateKey, s, aad: aad)
            })
            check("envelopes: one per device, each opens with its own key", try {
                let other = Seal.generateKeyPair()
                let list = try Seal.sealEnvelopes([("d1", fresh.publicKey), ("d2", other.publicKey)],
                                                  plaintext: "oba", aad: aad)
                let first = try Seal.open(privateKey: fresh.privateKey, Seal.Sealed(enc: list[0].enc, ct: list[0].ct),
                                          aad: aad)
                let second = try Seal.open(privateKey: other.privateKey, Seal.Sealed(enc: list[1].enc, ct: list[1].ct),
                                           aad: aad)
                return list.map(\.deviceId) == ["d1", "d2"] && first == "oba" && second == "oba"
            }())
        }
        check("aad is the exact contract string", try {
            try Seal.aad(kind: .reply, ref: "r", from: "a", to: "b") == Data("pingme v1|reply|r|a|b".utf8)
        }())
        check("aad rejects | in a field", throwsError { try Seal.aad(kind: .title, ref: "a|b", from: "a", to: "b") })
        check("aad rejects an empty field", throwsError { try Seal.aad(kind: .title, ref: "r", from: "", to: "b") })
        check("bad base64 key fails", throwsError { try Seal.seal(publicKey: "not base64", plaintext: "x", aad: Data()) })
        check("short key fails", throwsError { try Seal.seal(publicKey: "AAAA", plaintext: "x", aad: Data()) })
        check("newRef is 22 base64url chars", Seal.newRef().range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil)

        // 5. Emit Swift-made vectors for the web side to open.
        if let emit {
            do {
                let out = try samples.map { kind, text in
                    let ref = Seal.newRef(), from = "u_mac_test", to = "u_web_test"
                    let s = try Seal.seal(publicKey: tsPair.publicKey, plaintext: text,
                                          aad: Seal.aad(kind: kind, ref: ref, from: from, to: to))
                    return Vector(kind: kind.rawValue, ref: ref, from: from, to: to, plaintext: text, enc: s.enc, ct: s.ct)
                }
                let enc = JSONEncoder()
                enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
                try enc.encode(out).write(to: URL(fileURLWithPath: emit))
                print("emitted \(out.count) vectors to \(emit)")
            } catch {
                failed += 1
                print("FAIL emit: \(error)")
            }
        }

        print("\(passed) passed, \(failed) failed")
        return failed == 0
    }

    private static func hex(_ s: String) throws -> Data {
        let chars = Array(s.utf8)
        guard chars.count % 2 == 0 else { throw Seal.Failure.badField("hex") }
        var out = Data(capacity: chars.count / 2)
        for i in stride(from: 0, to: chars.count, by: 2) {
            guard let b = UInt8(String(decoding: chars[i..<i + 2], as: UTF8.self), radix: 16) else {
                throw Seal.Failure.badField("hex")
            }
            out.append(b)
        }
        return out
    }

    private static func flipFirstBit(_ b64: String) -> String {
        guard var d = Data(base64Encoded: b64), !d.isEmpty else { return b64 }
        d[d.startIndex] ^= 1
        return d.base64EncodedString()
    }
}
