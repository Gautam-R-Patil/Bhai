// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// ── Wizard name → Convex accounts.name ──
// OTPless's /validate-token rarely returns a display name (most users sign in
// by phone/email only). Without this sync, the admin panel's Users list shows
// every row as "Unnamed User" even though the setup wizard already collected
// a name. We push it to the server once per boot — Convex-side upsert is a
// no-op when the value already matches, so this is safe to call every boot.

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionToken, handleAuthError } from "../session.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";

const PROFILE_FILES = [
    // The seeded marker is the canonical source after first boot — wizard-seed
    // renames .user-profile.json → .user-profile.seeded.json so we read from
    // there first. On the very first boot, that marker doesn't exist yet, so
    // we fall back to the pre-seed file (wizard-seed will rename it later in
    // the same boot, after this sync runs).
    ".user-profile.seeded.json",
    ".user-profile.json",
];

function readWizardName(dirs: { userDataDir?: string; dataDir?: string }): string | null {
    const base = dirs.userDataDir || dirs.dataDir;
    if (!base) return null;
    for (const filename of PROFILE_FILES) {
        const file = path.join(base, filename);
        if (!fs.existsSync(file)) continue;
        try {
            const raw = fs.readFileSync(file, "utf-8");
            const parsed = JSON.parse(raw, (k, v) => {
                if (k === "__proto__" || k === "constructor" || k === "prototype") return undefined;
                return v;
            }) as { name?: unknown };
            if (typeof parsed?.name === "string" && parsed.name.trim()) {
                return parsed.name.trim();
            }
        } catch { /* try next file */ }
    }
    return null;
}

export interface AccountNameSyncResult {
    ran: boolean;
    reason?: "no-name" | "no-session" | "pushed" | "push-failed" | "already-synced" | "server-has-name";
    error?: string;
    name?: string;
}

// Marker file written after the first successful push. Stores the name that
// was last pushed so we can detect "wizard re-run with a different value"
// and re-push; once the wizard hasn't changed, repeated boots no-op and
// the admin-panel edit becomes the source of truth.
const PUSHED_MARKER = ".user-profile.name-synced";

interface NameSyncMarker {
    name?: string;
    pushedAt?: number;
}

function markerPath(dirs: { userDataDir?: string; dataDir?: string }): string | null {
    const base = dirs.userDataDir || dirs.dataDir;
    if (!base) return null;
    return path.join(base, PUSHED_MARKER);
}

function readMarker(p: string | null): NameSyncMarker | null {
    if (!p || !fs.existsSync(p)) return null;
    try {
        const raw = fs.readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as NameSyncMarker;
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        // Treat unreadable marker as "no marker" so we'll re-push and rewrite it.
        return null;
    }
}

export async function syncAccountNameIfPresent(
    dirs: { userDataDir?: string; dataDir?: string },
): Promise<AccountNameSyncResult> {
    const name = readWizardName(dirs);
    if (!name) return { ran: false, reason: "no-name" };

    // Skip only if the marker matches the CURRENT wizard name. If the wizard
    // was re-run with a different value, the marker is stale and we push
    // again. (The Convex server has its own "name already set" guard, so
    // even when we push, it will refuse to clobber an admin-panel edit
    // unless body.overwrite=true.)
    const marker = markerPath(dirs);
    const cached = readMarker(marker);
    if (cached && cached.name === name) {
        return { ran: false, reason: "already-synced", name };
    }

    const token = await getSessionToken();
    if (!token) return { ran: false, reason: "no-session" };

    const url = `${getConvexSiteUrl()}/api/account/update-profile`;
    const body = JSON.stringify({ name });
    let res = await encryptedFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
    });
    if (res.status === 401) {
        const refreshed = await handleAuthError();
        if (!refreshed) return { ran: false, reason: "no-session", error: "auth refresh failed" };
        res = await encryptedFetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${refreshed}`, "Content-Type": "application/json" },
            body,
        });
    }
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ran: false, reason: "push-failed", error: `HTTP ${res.status} ${txt.slice(0, 200)}` };
    }

    // Write the marker so the next boot doesn't re-push. Non-fatal if the
    // write fails — at worst we re-push once more next time.
    if (marker) {
        try {
            fs.writeFileSync(marker, JSON.stringify({ name, pushedAt: Date.now() }), "utf8");
        } catch { /* best-effort marker */ }
    }
    return { ran: true, reason: "pushed", name };
}
