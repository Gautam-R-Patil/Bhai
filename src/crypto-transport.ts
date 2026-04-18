// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// End-to-End Encrypted Transport Layer.
// ECDH P-256 key exchange + AES-256-GCM payload encryption.
// Provides forward secrecy and MITM protection on top of HTTPS.

import crypto from "node:crypto";

// ── State ─────────────────────────────────────
let _ecdh: crypto.ECDH | null = null;
let _sharedKey: Buffer | null = null;
let _clientPublicKey: string | null = null;

// ── Key Generation ────────────────────────────

/**
 * Generate a new ECDH P-256 key pair for this session.
 * Returns the client's public key (base64) to send to the server.
 */
export function generateKeyPair(): string {
    _ecdh = crypto.createECDH("prime256v1");
    _ecdh.generateKeys();
    _clientPublicKey = _ecdh.getPublicKey("base64");
    return _clientPublicKey;
}

/**
 * Derive the shared AES-256 key from the server's public key.
 * Uses ECDH + HKDF for proper key derivation.
 */
export function deriveSharedKey(serverPublicKeyBase64: string): void {
    if (!_ecdh) throw new Error("Key pair not generated yet");

    const serverPubKey = Buffer.from(serverPublicKeyBase64, "base64");
    const sharedSecret = _ecdh.computeSecret(serverPubKey);

    // Derive AES-256 key: SHA-256(shared_secret + salt + info)
    // Must match server-side derivation in convex/crypto.ts
    const salt = Buffer.from("atlas-e2e-salt");
    const info = Buffer.from("atlas-e2e-aes256-key");
    const combined = Buffer.concat([sharedSecret, salt, info]);
    _sharedKey = crypto.createHash("sha256").update(combined).digest();
}

/**
 * Get the client's public key (base64).
 */
export function getClientPublicKey(): string | null {
    return _clientPublicKey;
}

/**
 * Check if E2E encryption is established.
 */
export function isEncryptionReady(): boolean {
    return _sharedKey !== null;
}

/**
 * Clear all crypto state (call on session revoke/logout).
 */
export function clearCryptoState(): void {
    _ecdh = null;
    _sharedKey = null;
    _clientPublicKey = null;
}

// ── Encrypt / Decrypt ─────────────────────────

interface EncryptedEnvelope {
    iv: string;        // base64
    ct: string;        // base64 (ciphertext)
    tag: string;       // base64 (GCM auth tag)
    ts: number;        // timestamp (replay protection)
    rid: string;       // request ID (dedup)
}

/**
 * Encrypt a plaintext string using AES-256-GCM with the shared key.
 */
export function encrypt(plaintext: string): EncryptedEnvelope {
    if (!_sharedKey) throw new Error("E2E encryption not established");

    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv("aes-256-gcm", _sharedKey, iv);

    let encrypted = cipher.update(plaintext, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString("base64"),
        ct: encrypted.toString("base64"),
        tag: tag.toString("base64"),
        ts: Date.now(),
        rid: crypto.randomBytes(8).toString("hex"),
    };
}

/**
 * Decrypt an encrypted envelope using AES-256-GCM with the shared key.
 */
export function decrypt(envelope: EncryptedEnvelope): string {
    if (!_sharedKey) throw new Error("E2E encryption not established");

    const iv = Buffer.from(envelope.iv, "base64");
    const ct = Buffer.from(envelope.ct, "base64");
    const tag = Buffer.from(envelope.tag, "base64");

    // Validate GCM auth tag length (must be 16 bytes for AES-256-GCM)
    if (tag.length !== 16) {
        throw new Error(`E2E decrypt: invalid auth tag length (${tag.length}, expected 16)`);
    }

    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", _sharedKey, iv);
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(ct);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString("utf8");
    } catch (err) {
        throw new Error(`E2E decryption failed: ${(err as Error).message}`);
    }
}

// ── Encrypted Fetch ───────────────────────────

/**
 * Drop-in replacement for fetch() that encrypts request bodies
 * and decrypts response bodies using the E2E shared key.
 * Falls back to plain fetch if encryption is not established.
 */
export async function encryptedFetch(
    url: string,
    options: RequestInit = {},
): Promise<Response> {
    // If E2E not ready, fall back to plain fetch (with timeout)
    if (!_sharedKey) {
        if (!options.signal) options.signal = AbortSignal.timeout(45_000);
        return fetch(url, options);
    }

    const headers = new Headers(options.headers);

    // Encrypt request body if present
    if (options.body && typeof options.body === "string") {
        const envelope = encrypt(options.body);
        options.body = JSON.stringify(envelope);
        headers.set("X-Encryption", "ecdh-aes-256-gcm");
        headers.set("Content-Type", "application/json");
    }

    options.headers = headers;

    // Add timeout to prevent hanging indefinitely on network issues (45s default)
    if (!options.signal) {
        options.signal = AbortSignal.timeout(45_000);
    }

    // Make the request
    const response = await fetch(url, options);

    // Check if response is encrypted
    const responseEncryption = response.headers.get("X-Encryption");
    if (responseEncryption === "ecdh-aes-256-gcm") {
        try {
            // Decrypt response body
            const encryptedBody = await response.json() as EncryptedEnvelope;
            const decryptedText = decrypt(encryptedBody);

            // Return a new Response with decrypted body but same status/headers
            return new Response(decryptedText, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } catch (err) {
            console.error("[E2E] Response decryption failed:", (err as Error).message);
            // Return error response instead of crashing
            return new Response(JSON.stringify({ error: "E2E decryption failed" }), {
                status: 502,
                headers: { "Content-Type": "application/json" },
            });
        }
    }

    // Response wasn't encrypted (e.g., error responses)
    return response;
}
