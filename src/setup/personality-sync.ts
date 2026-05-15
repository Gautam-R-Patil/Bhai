// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// ── Wizard / Settings → Server Personality Addendum ──
// The Electron wizard's Personalize step (and the in-app Settings UI) writes
// the user's chosen personality preset + free-text notes to
// `.user-personality.json` in `userData`. The bot reads it here on boot,
// composes the addendum markdown, pushes it to /api/user/addendum/upsert
// with slug "user-personality" (kind: "personality"), and renames the file
// to `.user-personality.synced.json` to mark it shipped.
//
// On subsequent edits the wizard rewrites `.user-personality.json` — the
// bot's next-boot sync replaces the server-side addendum with the new
// content (upsert).

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionToken, handleAuthError } from "../session.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";

const FILENAME = ".user-personality.json";
const SYNCED_MARKER = ".user-personality.synced.json";

export interface PersonalityFile {
    preset: string;
    notes: string;
    updatedAt: number;
}

const PRESET_BODIES: Record<string, string> = {
    casual_playful: "Default to a casual, playful, warm tone with this user. Use contractions and the occasional emoji (max 1-2 per message). Witty observations welcome. Match their energy.",
    professional_concise: "Default to a professional, concise tone with this user. Minimize emoji (skip entirely unless they use one first). Get to the point. Skip filler words. Still warm, but disciplined.",
    warm_supportive: "Default to a warm, supportive, empathetic tone with this user. Drop sarcasm. Reduce jokes. Lead with validation when they share something hard. Encouragement over hype.",
    direct_terse: "Default to a direct, no-nonsense, action-first tone with this user. Skip pleasantries. Terse over verbose. State results, then optionally elaborate only if asked.",
};

function composeAddendumContent(p: PersonalityFile): string {
    const body = PRESET_BODIES[p.preset] ?? PRESET_BODIES.casual_playful;
    const lines = ["The user has set a personality preference for how you should sound.", "", body];
    if (p.notes && p.notes.trim().length > 0) {
        lines.push("", "Additional notes from the user:", p.notes.trim());
    }
    lines.push("", "Apply this consistently across channels. Core identity rules (ownership, anti-hallucination, no interrogation) still take precedence — this only shapes tone.");
    return lines.join("\n");
}

export function resolvePersonalityPaths(dirs: { userDataDir?: string; dataDir?: string }): { source: string; marker: string } {
    const base = dirs.userDataDir || dirs.dataDir || "";
    return {
        source: path.join(base, FILENAME),
        marker: path.join(base, SYNCED_MARKER),
    };
}

async function pushToServer(content: string): Promise<{ ok: boolean; error?: string; version?: number }> {
    const token = await getSessionToken();
    if (!token) return { ok: false, error: "no session token" };
    const url = `${getConvexSiteUrl()}/api/user/addendum/upsert`;
    const body = JSON.stringify({
        slug: "user-personality",
        kind: "personality",
        title: "User-chosen personality",
        content,
        reason: "Synced from wizard/settings personality picker",
        // user-personality is in the server's USER_CONTROLLED_SLUGS set; this
        // flag opts the personality-sync caller in. The agent's self-improvement
        // tools never set this, so they cannot clobber the wizard choice.
        allowUserControlled: true,
    });
    let res = await encryptedFetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body,
    });
    if (res.status === 401) {
        const refreshed = await handleAuthError();
        if (!refreshed) return { ok: false, error: "auth refresh failed" };
        res = await encryptedFetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${refreshed}`, "Content-Type": "application/json" },
            body,
        });
    }
    const json = await res.json().catch(() => ({})) as { success?: boolean; error?: string; version?: number };
    if (!res.ok || json.success === false) {
        return { ok: false, error: json.error || `HTTP ${res.status}` };
    }
    return { ok: true, version: json.version };
}

export interface PersonalitySyncResult {
    ran: boolean;
    reason?: "no-file" | "parse-error" | "push-failed" | "synced" | "session-not-ready";
    error?: string;
    version?: number;
}

export async function syncPersonalityIfPresent(dirs: { userDataDir?: string; dataDir?: string }): Promise<PersonalitySyncResult> {
    const { source, marker } = resolvePersonalityPaths(dirs);
    if (!source) return { ran: false, reason: "no-file" };
    if (!fs.existsSync(source)) return { ran: false, reason: "no-file" };

    let parsed: PersonalityFile;
    try {
        const raw = fs.readFileSync(source, "utf-8");
        // Reviver strips __proto__ / constructor / prototype keys to block
        // prototype-pollution payloads in a user-writable file.
        parsed = JSON.parse(raw, (k, v) => {
            if (k === "__proto__" || k === "constructor" || k === "prototype") return undefined;
            return v;
        }) as PersonalityFile;
    } catch (err) {
        return { ran: false, reason: "parse-error", error: (err as Error).message };
    }
    if (!parsed || typeof parsed !== "object") {
        return { ran: false, reason: "parse-error", error: "file is not an object" };
    }
    if (!parsed.preset || typeof parsed.preset !== "string") {
        return { ran: false, reason: "parse-error", error: "preset missing" };
    }
    // Object.hasOwn avoids walking the prototype chain (`in` would).
    if (!Object.hasOwn(PRESET_BODIES, parsed.preset)) {
        return { ran: false, reason: "parse-error", error: `unknown preset '${parsed.preset}'` };
    }

    const content = composeAddendumContent(parsed);
    const push = await pushToServer(content);
    if (!push.ok) {
        return { ran: false, reason: "push-failed", error: push.error };
    }
    // Rename source → synced marker so the next boot doesn't re-push the
    // same content unless the wizard/Settings UI writes a new file.
    try {
        if (fs.existsSync(marker)) {
            try { fs.unlinkSync(marker); } catch { /* */ }
        }
        fs.renameSync(source, marker);
    } catch (err) {
        // Non-fatal: server got the update; we just couldn't update local
        // file state. Next boot may re-push, which is harmless (upsert).
        console.warn(`[personality-sync] couldn't rename ${source}:`, (err as Error).message);
    }
    return { ran: true, reason: "synced", version: push.version };
}
