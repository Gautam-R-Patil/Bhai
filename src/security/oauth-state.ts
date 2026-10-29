// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// ── OAuth `state` for local callback servers ──
// A loopback callback that takes the first ?code= / ?error= it sees can be
// aborted, or handed someone else's account, by any page that loads the URL.
// Each flow sends a random state and its callback ignores requests without it.

import { randomBytes, timingSafeEqual } from "node:crypto";

export const newOAuthState = (): string => randomBytes(24).toString("base64url");

/** Constant-time match of the callback's `state` against the one this flow sent. */
export function oauthStateMatches(got: string | null, expected: string): boolean {
    if (!got) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
