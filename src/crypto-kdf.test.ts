// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import {
    deriveE2EKey,
    isSupportedKdfVersion,
    KDF_VERSION_LEGACY,
    KDF_VERSION_HKDF,
    KDF_VERSION_LATEST,
    SUPPORTED_KDF_VERSIONS,
} from "./crypto-kdf.js";

// ── Test helpers ─────────────────────────────────────────────────
const hex = (b: Buffer) => b.toString("hex");
const fromHex = (h: string) => Buffer.from(h, "hex");

describe("crypto-kdf", () => {
    describe("deriveE2EKey — version dispatch + output shape", () => {
        const shared = Buffer.from("some-ecdh-shared-secret-bytes".padEnd(32, "0"));
        const salt = Buffer.from("atlas-e2e-salt");
        const info = Buffer.from("atlas-e2e-aes256-key");

        it("v1 (legacy) returns 32 bytes", () => {
            const key = deriveE2EKey(shared, salt, info, KDF_VERSION_LEGACY);
            expect(key.length).toEqual(32);
        });

        it("v2 (HKDF) returns 32 bytes", () => {
            const key = deriveE2EKey(shared, salt, info, KDF_VERSION_HKDF);
            expect(key.length).toEqual(32);
        });

        it("default version is the latest known (v2 HKDF)", () => {
            const defaulted = deriveE2EKey(shared, salt, info);
            const explicitV2 = deriveE2EKey(shared, salt, info, KDF_VERSION_HKDF);
            expect(hex(defaulted)).toEqual(hex(explicitV2));
            expect(KDF_VERSION_LATEST).toEqual(KDF_VERSION_HKDF);
        });

        it("v1 and v2 produce DIFFERENT keys from the same input", () => {
            // If these ever collided it would indicate one of the
            // implementations is accidentally degenerate.
            const k1 = deriveE2EKey(shared, salt, info, KDF_VERSION_LEGACY);
            const k2 = deriveE2EKey(shared, salt, info, KDF_VERSION_HKDF);
            expect(hex(k1)).not.toEqual(hex(k2));
        });

        it("v1 is deterministic — same input twice yields identical output", () => {
            const a = deriveE2EKey(shared, salt, info, KDF_VERSION_LEGACY);
            const b = deriveE2EKey(shared, salt, info, KDF_VERSION_LEGACY);
            expect(hex(a)).toEqual(hex(b));
        });

        it("v2 is deterministic — same input twice yields identical output", () => {
            const a = deriveE2EKey(shared, salt, info, KDF_VERSION_HKDF);
            const b = deriveE2EKey(shared, salt, info, KDF_VERSION_HKDF);
            expect(hex(a)).toEqual(hex(b));
        });

        it("different shared secrets → different keys (both versions)", () => {
            const s2 = Buffer.from("some-other-ecdh-shared-secret".padEnd(32, "1"));
            for (const v of SUPPORTED_KDF_VERSIONS) {
                const k1 = deriveE2EKey(shared, salt, info, v);
                const k2 = deriveE2EKey(s2, salt, info, v);
                expect(hex(k1), `version ${v}`).not.toEqual(hex(k2));
            }
        });

        it("different salt → different keys (both versions)", () => {
            const salt2 = Buffer.from("different-salt-value");
            for (const v of SUPPORTED_KDF_VERSIONS) {
                const k1 = deriveE2EKey(shared, salt, info, v);
                const k2 = deriveE2EKey(shared, salt2, info, v);
                expect(hex(k1), `version ${v}`).not.toEqual(hex(k2));
            }
        });

        it("different info → different keys (both versions)", () => {
            const info2 = Buffer.from("different-info");
            for (const v of SUPPORTED_KDF_VERSIONS) {
                const k1 = deriveE2EKey(shared, salt, info, v);
                const k2 = deriveE2EKey(shared, salt, info2, v);
                expect(hex(k1), `version ${v}`).not.toEqual(hex(k2));
            }
        });

        it("throws on unsupported version", () => {
            expect(() => deriveE2EKey(shared, salt, info, 99)).toThrow(/Unsupported KDF version/);
        });

        it("accepts Uint8Array inputs as well as Buffer", () => {
            const sharedU8 = new Uint8Array(shared);
            const saltU8 = new Uint8Array(salt);
            const infoU8 = new Uint8Array(info);
            const key = deriveE2EKey(sharedU8, saltU8, infoU8, KDF_VERSION_HKDF);
            expect(key.length).toEqual(32);
        });
    });

    describe("v2 HKDF — RFC 5869 test vector A.1", () => {
        // RFC 5869 A.1: Basic test case with SHA-256.
        // IKM  = 0x0b × 22
        // salt = 0x000102030405060708090a0b0c (13 bytes)
        // info = 0xf0f1f2f3f4f5f6f7f8f9 (10 bytes)
        // L    = 42
        // OKM  = 0x3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
        const ikm = Buffer.from("0b".repeat(22), "hex");
        const salt = fromHex("000102030405060708090a0b0c");
        const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
        const rfcOkm42 =
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

        it("matches RFC 5869 A.1 first 32 bytes", () => {
            // deriveE2EKey produces 32 bytes — the first 32 of the
            // RFC's 42-byte OKM must match exactly.
            const key = deriveE2EKey(ikm, salt, info, KDF_VERSION_HKDF);
            expect(hex(key)).toEqual(rfcOkm42.substring(0, 64));
        });
    });

    describe("v1 legacy — pins the exact pre-rollout hash", () => {
        // If anyone ever changes the v1 derivation by accident, this
        // test locks in the exact output of the original
        // SHA256(shared ‖ salt ‖ info) construction for a known input.
        it("produces a known-answer SHA-256(shared ‖ salt ‖ info)", () => {
            const shared = Buffer.from("hello", "utf8");
            const salt = Buffer.from("salty", "utf8");
            const info = Buffer.from("info!", "utf8");

            // Reference: sha256("hello" + "salty" + "info!")
            //          = sha256("hellosaltyinfo!") — generated via
            // `node -e "console.log(require('crypto').createHash('sha256').update('hellosaltyinfo!').digest('hex'))"`
            const key = deriveE2EKey(shared, salt, info, KDF_VERSION_LEGACY);
            expect(hex(key)).toEqual(
                "7e3c0d72ecf1edb9a763d715f21a963445ea8a30846b80f23c87dd782eddf20c",
            );
        });
    });

    describe("isSupportedKdfVersion", () => {
        it("accepts 1 and 2", () => {
            expect(isSupportedKdfVersion(KDF_VERSION_LEGACY)).toBe(true);
            expect(isSupportedKdfVersion(KDF_VERSION_HKDF)).toBe(true);
        });

        it("rejects unknown numbers", () => {
            expect(isSupportedKdfVersion(0)).toBe(false);
            expect(isSupportedKdfVersion(3)).toBe(false);
            expect(isSupportedKdfVersion(-1)).toBe(false);
        });

        it("rejects non-numbers", () => {
            expect(isSupportedKdfVersion("2")).toBe(false);
            expect(isSupportedKdfVersion(null)).toBe(false);
            expect(isSupportedKdfVersion(undefined)).toBe(false);
            expect(isSupportedKdfVersion({})).toBe(false);
        });
    });
});
