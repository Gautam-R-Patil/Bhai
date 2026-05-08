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
    };
}

function isLegacyUserId(userId) {
    if (!userId || typeof userId !== "string") return false;
    return /^(phone_|google_)/.test(userId);
}

module.exports = {
    parseOtplessVerifyResponse,
    isLegacyUserId,
};
