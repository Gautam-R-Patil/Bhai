// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// End-to-End Encrypted Transport Layer.
// ECDH P-256 key exchange + AES-256-GCM payload encryption.
// Provides forward secrecy and MITM protection on top of HTTPS.

import crypto from "node:crypto";
import { deriveE2EKey, KDF_VERSION_LATEST, type KdfVersion } from "./crypto-kdf.js";
import type { Frame } from "./llm-stream.js";

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
 *
 * `version` selects the KDF: pass the same `kdfVersion` the server
 * echoed in the `/api/auth/session` response so both sides agree
 * byte-for-byte on the derived key. Defaults to KDF_VERSION_LATEST
 * (HKDF-SHA256) for new sessions — existing v1 sessions pass 1.
 *
 * Must stay in lockstep with server-side derivation in
 * `convex/crypto.ts::deriveSharedKey`.
 */
export function deriveSharedKey(
    serverPublicKeyBase64: string,
    version: KdfVersion = KDF_VERSION_LATEST,
): void {
    if (!_ecdh) throw new Error("Key pair not generated yet");

    // Refuse legacy KDF v1 client-side. v1 is a SHA256-concat, not a real
    // KDF; the server still decrypts existing v1 sessions for backward
    // compat, but the client will only DERIVE under HKDF (v2). A coerced
    // server (or downgrade attack on the unencrypted /api/auth/session
    // bootstrap) cannot push us back onto v1.
    if (version !== KDF_VERSION_LATEST) {
        throw new Error(
            `KDF version ${version} refused by client; only v${KDF_VERSION_LATEST} (HKDF-SHA256) is accepted.`,
        );
    }

    if (!_clientPublicKey) {
        throw new Error("Client public key not staged — call generateKeyPair() before deriveSharedKey()");
    }

    const serverPubKey = Buffer.from(serverPublicKeyBase64, "base64");
    const sharedSecret = _ecdh.computeSecret(serverPubKey);

    const salt = Buffer.from("atlas-e2e-salt");
    // Bind both pubkeys into the HKDF info so a key-substitution under a TLS
    // MITM breaks derivation. MUST byte-match convex/crypto.ts::deriveSharedKey:
    //   `atlas-e2e-aes256-key|${clientPublicKey}|${serverPublicKey}`
    const info = Buffer.from(
        `atlas-e2e-aes256-key|${_clientPublicKey}|${serverPublicKeyBase64}`,
    );
    _sharedKey = deriveE2EKey(sharedSecret, salt, info, version);
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
 * Build the AAD (Additional Authenticated Data) for an envelope.
 *
 * AAD is unencrypted but cryptographically bound to the ciphertext via the
 * GCM auth tag — modifying AAD on the wire breaks decryption. We bind the
 * HTTP method, the URL pathname, and the envelope's ts+rid so that:
 *   - A captured envelope cannot be replayed against a different route
 *     (cross-protocol confusion).
 *   - An on-path attacker who flips ts/rid on the wire (the previous
 *     90-second replay window relied on these being unauthenticated)
 *     can no longer get the server to accept the rewritten envelope.
 */
function buildAAD(method: string, urlPath: string, ts: number, rid: string): Buffer {
    return Buffer.from(`${method.toUpperCase()}|${urlPath}|${ts}|${rid}`);
}

/**
 * Encrypt a plaintext string using AES-256-GCM with the shared key.
 *
 * `bindAad` — when provided, becomes Associated Authenticated Data
 * (RFC 5116). Both peers must compute the same AAD or decryption fails.
 * Callers should pass `buildAAD(method, urlPath, ts, rid)` derived from
 * the request being encrypted.
 */
export function encrypt(plaintext: string, bindAad?: Buffer): EncryptedEnvelope {
    if (!_sharedKey) throw new Error("E2E encryption not established");

    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const ts = Date.now();
    const rid = crypto.randomBytes(16).toString("hex");
    const cipher = crypto.createCipheriv("aes-256-gcm", _sharedKey, iv);
    if (bindAad) cipher.setAAD(bindAad);

    let encrypted = cipher.update(plaintext, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString("base64"),
        ct: encrypted.toString("base64"),
        tag: tag.toString("base64"),
        ts,
        rid,
    };
}

/**
 * Decrypt an encrypted envelope using AES-256-GCM with the shared key.
 * `bindAad` must match the AAD used when encrypting.
 */
export function decrypt(envelope: EncryptedEnvelope, bindAad?: Buffer): string {
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
        if (bindAad) decipher.setAAD(bindAad);

        let decrypted = decipher.update(ct);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString("utf8");
    } catch (err) {
        throw new Error(`E2E decryption failed: ${(err as Error).message}`);
    }
}

/**
 * Decrypt one streamed NDJSON frame. The AAD binds the request id, the frame's
 * position and the end flag, so a reordered, replayed, cross-request or
 * truncated-then-forged frame fails the GCM tag.
 */
export function decryptFrame(line: string, reqRid: string, expectSeq: number): { frame: Frame; final: boolean } {
    const env = JSON.parse(line) as EncryptedEnvelope;
    for (const final of [false, true]) {
        const aad = Buffer.from(`POST|/api/llm/chat|${env.ts}|${env.rid}|${reqRid}|${expectSeq}|${final ? 1 : 0}`);
        let text: string;
        try {
            text = decrypt(env, aad);
        } catch {
            continue;
        }
        const { pad: _pad, ...frame } = JSON.parse(text) as Frame & { pad?: string };
        return { frame, final };
    }
    throw new Error(`stream frame ${expectSeq} rejected (bad tag, order or request)`);
}

// ── Encrypted Fetch ───────────────────────────

/**
 * Endpoints that legitimately run BEFORE the shared key is derived.
 * Plaintext is acceptable on these because they're the ECDH bootstrap
 * itself. Every other request MUST be encrypted; the previous behaviour
 * of silently falling back to plaintext let a stale-token race ship
 * sensitive payloads in the clear under normal HTTPS only.
 */
const PRE_E2E_PLAINTEXT_PATHS = new Set([
    "/api/auth/session",
    "/api/otpless/validate-token",
    "/api/auth/refresh",
]);

// Per-attempt request deadline. Each fallback hop in LLMClient.chat() issues a
// fresh encryptedFetch with its own AbortSignal, so this bounds a SINGLE model
// attempt — not the whole chain. A hung/dead model (e.g. a 404 slug that never
// answers) is abandoned at this deadline and the chain advances to the next
// model, instead of stalling the previous 45s and stacking into ~55s+ totals.
// Override with BHAI_LLM_ATTEMPT_TIMEOUT_MS for slow links.
const ATTEMPT_TIMEOUT_MS = Number(process.env.BHAI_LLM_ATTEMPT_TIMEOUT_MS) || 25_000;

function urlPathOf(rawUrl: string): string {
    try {
        return new URL(rawUrl).pathname;
    } catch {
        // Bare path passed (rare) — best-effort.
        return rawUrl.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
    }
}

/**
 * Seal a request body into an envelope whose AAD binds method, path and a
 * fresh ts/rid (pre-allocated so the same values go into the AAD).
 */
function sealBody(method: string, urlPath: string, body: string): { body: string; rid: string } {
    if (!_sharedKey) throw new Error("E2E encryption not established");
    const ts = Date.now();
    const rid = crypto.randomBytes(16).toString("hex");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", _sharedKey, iv);
    cipher.setAAD(buildAAD(method, urlPath, ts, rid));
    const ct = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    const envelope: EncryptedEnvelope = {
        iv: iv.toString("base64"),
        ct: ct.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ts,
        rid,
    };
    return { body: JSON.stringify(envelope), rid };
}

/**
 * Decrypt a whole-body response envelope (the server echoes its own ts/rid;
 * we re-bind them to method+urlPath, which is what we control on this side).
 */
export function openEnvelope(text: string, method: string, urlPath: string): string {
    const env = JSON.parse(text) as EncryptedEnvelope;
    return decrypt(env, buildAAD(method, urlPath, env.ts, env.rid));
}

/**
 * Drop-in replacement for fetch() that encrypts request bodies and
 * decrypts response bodies using the E2E shared key.
 *
 * Behaviour change vs. earlier versions: when the shared key is missing,
 * we ONLY allow the call through if the URL path is on the
 * PRE_E2E_PLAINTEXT_PATHS allowlist. Every other call throws — the
 * previous silent plaintext fallback meant authenticated, sensitive
 * traffic could ship in the clear during a session-revocation race.
 */
export async function encryptedFetch(
    url: string,
    options: RequestInit = {},
): Promise<Response> {
    const method = (options.method || "GET").toUpperCase();
    const urlPath = urlPathOf(url);

    if (!_sharedKey) {
        if (!PRE_E2E_PLAINTEXT_PATHS.has(urlPath)) {
            throw new Error(
                `E2E required for ${method} ${urlPath}; shared key missing. Re-auth before issuing this request.`,
            );
        }
        if (!options.signal) options.signal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
        return fetch(url, options);
    }

    const headers = new Headers(options.headers);

    // Signal E2E capability on every request once a shared key exists, even
    // bodyless GETs. Endpoints that ship sensitive secrets (e.g.
    // /api/config/secrets, /api/keys/voice) refuse with 400 unless this header
    // is present; the server then encrypts the response, which the decrypt
    // path below unwraps. Endpoints that conditionally encrypt are unaffected.
    headers.set("X-Encryption", "ecdh-aes-256-gcm");

    // Encrypt request body if present
    if (options.body && typeof options.body === "string") {
        options.body = sealBody(method, urlPath, options.body).body;
        headers.set("Content-Type", "application/json");
    }

    options.headers = headers;

    // Add timeout to prevent hanging indefinitely on network issues.
    // Per-attempt (see ATTEMPT_TIMEOUT_MS) so a hung model fails over fast.
    if (!options.signal) {
        options.signal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    }

    // Make the request
    const response = await fetch(url, options);

    // Check if response is encrypted
    const responseEncryption = response.headers.get("X-Encryption");
    if (responseEncryption === "ecdh-aes-256-gcm") {
        try {
            // Decrypt response body — bind same AAD shape (the server
            // echoes ts/rid, but we re-bind to method+urlPath which is
            // what we control on this side).
            const decryptedText = openEnvelope(await response.text(), method, urlPath);

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

/**
 * Encrypted POST that asks the server to stream frames: same auth and
 * encryption as encryptedFetch, with `stream: true` added to the JSON body.
 * Returns the response unread plus the request's rid, which every frame's AAD
 * is bound to (read it with readFrames from ./llm-stream.js). No default
 * deadline here: a total timeout would cut a healthy long answer, so the
 * caller bounds the wait (signal) and readFrames bounds first frame + gaps.
 */
export async function encryptedFetchStream(
    url: string,
    options: RequestInit,
): Promise<{ response: Response; rid: string }> {
    const method = (options.method || "POST").toUpperCase();
    const urlPath = urlPathOf(url);
    if (!_sharedKey) {
        throw new Error(
            `E2E required for ${method} ${urlPath}; shared key missing. Re-auth before issuing this request.`,
        );
    }
    if (typeof options.body !== "string") throw new Error("encryptedFetchStream needs a JSON string body");
    const sealed = sealBody(method, urlPath, JSON.stringify({ ...JSON.parse(options.body), stream: true }));
    const headers = new Headers(options.headers);
    headers.set("X-Encryption", "ecdh-aes-256-gcm");
    headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...options, method, headers, body: sealed.body });
    return { response, rid: sealed.rid };
}
