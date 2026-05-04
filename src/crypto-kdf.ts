// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── E2E Key-Derivation Function (KDF) ───────────────────────────
// Extracted from crypto-transport.ts so the KDF math can be tested
// against RFC 5869 vectors without spinning up an ECDH session.
//
// Two versions are supported for backward-compat during rollout:
//
//   v1 (legacy): SHA256(sharedSecret ‖ salt ‖ info) — the original,
//       shipped in all sessions created before the HKDF rollout.
//       Weak on paper (not a KDF, just a hash) but the ephemeral
//       ECDH shared secret already has enough entropy that it's
//       not immediately exploitable.
//
//   v2 (preferred): HKDF-SHA256(sharedSecret, salt, info, 32 bytes).
//       Proper RFC 5869 extract-and-expand — gives domain separation
//       and collision resistance that v1 lacks. Used by every new
//       session once both client and server have the v2 deploy.
//
// Version dispatch lives in the single deriveE2EKey() entrypoint so
// every caller (crypto-transport.ts on the client, convex/crypto.ts
// on the server) stays consistent.

import { createHash, hkdfSync } from "node:crypto";

export const KDF_VERSION_LEGACY = 1;
export const KDF_VERSION_HKDF = 2;
export const KDF_VERSION_LATEST = KDF_VERSION_HKDF;

/** All KDF versions the client knows how to produce. */
export const SUPPORTED_KDF_VERSIONS = [KDF_VERSION_LEGACY, KDF_VERSION_HKDF] as const;

export type KdfVersion = (typeof SUPPORTED_KDF_VERSIONS)[number];

/**
 * Derive a 32-byte (AES-256) key from an ECDH shared secret.
 *
 * @param sharedSecret   ECDH-derived byte buffer (not a password).
 * @param salt           KDF salt (short, deterministic application constant).
 * @param info           KDF context string (short, deterministic).
 * @param version        KDF version — defaults to the latest known.
 * @returns              Exactly 32 bytes of keying material.
 * @throws               If version is not in SUPPORTED_KDF_VERSIONS.
 */
export function deriveE2EKey(
    sharedSecret: Buffer | Uint8Array,
    salt: Buffer | Uint8Array,
    info: Buffer | Uint8Array,
    version: number = KDF_VERSION_LATEST,
): Buffer {
    if (version === KDF_VERSION_LEGACY) {
        // SHA256 is not a KDF — this was a defensible shortcut given
        // the high entropy of the ECDH output, but it lacks domain
        // separation. Kept only for existing sessions still in-flight.
        return createHash("sha256").update(sharedSecret).update(salt).update(info).digest();
    }
    if (version === KDF_VERSION_HKDF) {
        // Node returns an ArrayBuffer from hkdfSync — wrap it so the
        // return type matches v1.
        const okm = hkdfSync("sha256", sharedSecret, salt, info, 32);
        return Buffer.from(okm);
    }
    throw new Error(`Unsupported KDF version: ${version}`);
}

/** True iff the given number is a recognized KDF version. */
export function isSupportedKdfVersion(v: unknown): v is KdfVersion {
    return (
        typeof v === "number" &&
        (SUPPORTED_KDF_VERSIONS as readonly number[]).includes(v)
    );
}
