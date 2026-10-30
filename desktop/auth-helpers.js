// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure helpers pulled out of main.js for unit-testability. No Electron imports.

function parseOtplessVerifyResponse(raw) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "Empty response" };
    if (raw.error) return { ok: false, error: String(raw.error) };
    if (!raw.session || !raw.session.token) return { ok: false, error: "Missing session in response" };
    if (!raw.userId) return { ok: false, error: "Missing userId in response" };
    return {
        ok: true,
        session: raw.session,
        userId: raw.userId,
        email: raw.email || undefined,
        phone: raw.phone || undefined,
        name: raw.name || undefined,
        // Proof for later sessions on this device (/api/auth/session needs it).
        deviceSecret: typeof raw.deviceSecret === "string" ? raw.deviceSecret : undefined,
    };
}

function isLegacyUserId(userId) {
    if (!userId || typeof userId !== "string") return false;
    return /^(phone_|google_)/.test(userId);
}

// F1 helper: is `resolved` (already-absolute) contained in `rootAbs` (already-absolute).
// Both inputs must be passed through path.resolve() by the caller. The check is
// a literal prefix comparison plus a separator boundary so /foo/bar is NOT
// considered inside /foo/ba.
function isPathContained(rootAbs, resolved, sep) {
    if (typeof rootAbs !== "string" || typeof resolved !== "string") return false;
    if (resolved === rootAbs) return true;
    return resolved.startsWith(rootAbs + sep);
}

// F2 helper: generate a 32-byte random hex string for OAuth state (and other
// CSRF tokens). Crypto.randomBytes is the canonical Node CSPRNG.
function generateOAuthState() {
    return require("node:crypto").randomBytes(32).toString("hex");
}

// F2 helper: constant-time string equality. Use for OAuth state comparison so
// a timing attacker can't enumerate the state byte-by-byte. Returns false on
// length mismatch (already-constant time for that path; the variable-length
// branch happens only on the length check itself).
function safeStringEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

module.exports = {
    parseOtplessVerifyResponse,
    isLegacyUserId,
    isPathContained,
    generateOAuthState,
    safeStringEqual,
};
