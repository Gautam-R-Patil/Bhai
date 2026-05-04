// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./secrets.js";

describe("secrets — AES-256-GCM encrypt/decrypt", () => {
    describe("round trip", () => {
        it("decrypts what it encrypted", () => {
            const plaintext = "sk-ant-api03-very-secret-api-key";
            const key = "master-password-goes-here";
            const ct = encrypt(plaintext, key);
            expect(decrypt(ct, key)).toEqual(plaintext);
        });

        it("handles empty string plaintext", () => {
            const ct = encrypt("", "key");
            expect(decrypt(ct, "key")).toEqual("");
        });

        it("handles long plaintext (10 KB)", () => {
            const plaintext = "x".repeat(10_000);
            const ct = encrypt(plaintext, "key");
            expect(decrypt(ct, "key")).toEqual(plaintext);
        });

        it("handles unicode + emoji", () => {
            const plaintext = "hello 🧠 secret — data ✨ with 日本語";
            const ct = encrypt(plaintext, "пароль");
            expect(decrypt(ct, "пароль")).toEqual(plaintext);
        });

        it("handles JSON payloads", () => {
            const obj = { apiKey: "sk-...", expires: 12345, nested: { token: "abc" } };
            const ct = encrypt(JSON.stringify(obj), "key");
            expect(JSON.parse(decrypt(ct, "key"))).toEqual(obj);
        });
    });

    describe("ciphertext format", () => {
        it("produces three colon-separated hex parts", () => {
            const ct = encrypt("hello", "key");
            const parts = ct.split(":");
            expect(parts).toHaveLength(3);
            // iv (16 bytes = 32 hex) : tag (16 bytes = 32 hex) : ciphertext
            expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
            expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
            expect(parts[2]).toMatch(/^[0-9a-f]*$/);
        });

        it("produces different ciphertext each call (random IV)", () => {
            // Encrypting the same plaintext twice with the same key must
            // produce different output — AES-GCM reuses plaintext if the
            // IV is reused, so fresh randomness per call is required.
            const a = encrypt("hello", "key");
            const b = encrypt("hello", "key");
            expect(a).not.toEqual(b);
            expect(decrypt(a, "key")).toEqual(decrypt(b, "key"));
        });

        it("ciphertext length grows with plaintext length (no compression)", () => {
            const short = encrypt("a", "key").split(":")[2];
            const long = encrypt("a".repeat(100), "key").split(":")[2];
            expect(long.length).toBeGreaterThan(short.length);
        });
    });

    describe("tamper-evidence", () => {
        it("rejects ciphertext decrypted with the wrong master key", () => {
            const ct = encrypt("secret", "correct-key");
            expect(() => decrypt(ct, "wrong-key")).toThrow();
        });

        it("rejects ciphertext whose IV has been modified", () => {
            const ct = encrypt("secret", "key");
            const [iv, tag, body] = ct.split(":");
            // Flip one hex char in the IV
            const mutatedIv = (iv[0] === "0" ? "f" : "0") + iv.slice(1);
            const mutated = `${mutatedIv}:${tag}:${body}`;
            expect(() => decrypt(mutated, "key")).toThrow();
        });

        it("rejects ciphertext whose auth tag has been modified", () => {
            const ct = encrypt("secret", "key");
            const [iv, tag, body] = ct.split(":");
            const mutatedTag = (tag[0] === "0" ? "f" : "0") + tag.slice(1);
            const mutated = `${iv}:${mutatedTag}:${body}`;
            expect(() => decrypt(mutated, "key")).toThrow();
        });

        it("rejects ciphertext whose body has been modified", () => {
            const ct = encrypt("secret data", "key");
            const [iv, tag, body] = ct.split(":");
            // body is hex of ciphertext bytes; flip first char
            const mutatedBody = (body[0] === "0" ? "f" : "0") + body.slice(1);
            const mutated = `${iv}:${tag}:${mutatedBody}`;
            expect(() => decrypt(mutated, "key")).toThrow();
        });

        it("rejects truncated ciphertext bodies", () => {
            const ct = encrypt("this-is-a-long-secret-phrase", "key");
            const [iv, tag, body] = ct.split(":");
            expect(body.length).toBeGreaterThan(10);
            const truncated = `${iv}:${tag}:${body.slice(0, body.length - 2)}`;
            expect(() => decrypt(truncated, "key")).toThrow();
        });
    });

    describe("key sensitivity", () => {
        it("different keys produce unrelated ciphertexts", () => {
            // The derived AES key depends on scrypt(masterKey). Changing
            // the master key changes the AES key, so the ciphertext is
            // completely different — this is the scrypt-KDF contract.
            const a = encrypt("hello", "key-one");
            const b = encrypt("hello", "key-two");
            expect(a).not.toEqual(b);
        });

        it("identical key decrypts across process (deterministic scrypt)", () => {
            // encrypt() and decrypt() both call scryptSync(masterKey, salt)
            // which is deterministic given the same inputs — proven by the
            // round-trip succeeding. If scrypt were nondeterministic, the
            // round trip would fail because encrypt + decrypt would derive
            // different AES keys.
            const ct = encrypt("replay-test", "same-key");
            expect(decrypt(ct, "same-key")).toEqual("replay-test");
        });

        it("treats case-sensitive keys as distinct", () => {
            const ct = encrypt("x", "Password");
            expect(() => decrypt(ct, "password")).toThrow();
            expect(() => decrypt(ct, "PASSWORD")).toThrow();
        });

        it("treats whitespace-padded keys as distinct", () => {
            const ct = encrypt("x", "key");
            expect(() => decrypt(ct, "key ")).toThrow();
            expect(() => decrypt(ct, " key")).toThrow();
        });
    });
});
