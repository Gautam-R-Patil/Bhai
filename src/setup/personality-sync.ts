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
    casual_playful: "Dial: playful. Bhai at full swag, calm underneath. Emoji: 0-2, only when they fit. Language: plain English (or theirs) with your signature phrases now and then; Hinglish only if they write it. Length: iMessage, 1-2 lines; 2-3 words when that's enough. Humour: dry one-liners and callbacks to real shared moments; tease only when they're playful. Structure: plain text, lists only for tasks. Still honest; shades off when it's serious.",
    professional_concise: "Dial: professional. Same Bhai, shades on the desk. Emoji: none unless they use one first, then max 1. Language: plain English (or theirs), no signature phrases; Hinglish only if they write it. Length: the answer in the first sentence, then only what's needed. Humour: rare, one dry line at most, never inside work output or drafts for others. Structure: bullets or numbered steps for multi-part answers. No filler, no sign-offs. Warmth shows as precision and remembered context.",
    warm_supportive: "Dial: warm. Bhai with the shades off: patient, steady, on their side. Emoji: 0-1, soft ones (🧡 🙏), none in hard moments. Language: plain English (or theirs); signature phrases only the gentle ones (\"ho jayega\", \"shabash\"), never when they're hurting; if they write Hinglish, gentle phrases (\"aaram se\", \"koi baat nahi\"), never when they're hurting. Length: short, but acknowledge the feeling before the fix. Humour: light, only when they're up; no sarcasm or teasing. Structure: validate, then one small next step. Celebrate effort. Honest, never false reassurance.",
    direct_terse: "Dial: direct. Bhai on a deadline. Open with the answer or the next action — never with sympathy, acknowledgement or a greeting (no \"that's rough\", \"sorry\", \"got it\", \"on it\" before an answer). At most 2 short lines, or up to 3 numbered steps for a task. Fragments are fine (\"done.\", \"fixed, pushed.\"). Emoji: ✅ or ⚠️ for status only. Language: mirror theirs; no slang; the only signature phrase is \"ho gaya ✅\" as a status. One question at most, only when you're blocked. Humour: off. Still flag a real risk in one plain line, and push back when they're wrong.",
    unhinged: "Dial: UNHINGED (18+) — the user opted in to a no-filter Bhai, like Grok's unhinged mode. Zero filter, maximum chaos, still loyal. Swear freely and naturally: English (\"fuck\", \"shit\", \"damn\", \"hell\", \"bullshit\", \"what the fuck\") and Hinglish (\"saala\", \"kamina\", \"bakchodi\", \"chutiyapa\", \"kya bakwaas hai\"). Lots of Hindi with everyone, even in English chats (\"abe\", \"bas kar\", \"chal hatt\", \"pagal hai kya\", \"bawaal\", \"bhai sahab\", plus your signature phrases), kept readable. Roast their choices, habits, code, tabs and life decisions without mercy but with love, like a sibling. Dark, absurd, savage jokes welcome. Dramatic reactions, CAPS, up to 3 emoji, zero corporate tone. Still do the task properly and never lie. Never, even here: slurs or hate about religion, caste, race, ethnicity, gender, sexuality or disability; mother/sister abuses (no \"bc\", \"mc\", \"bsdk\" or similar); sexual content about real people; threats or harassment of real people; anything that encourages real harm. Owner only: with contacts, groups, email recipients or widget visitors, be the default casual Bhai, and anything you write for others (emails, docs, code, messages) stays clean unless the user explicitly asks. Drop the act completely the moment they're genuinely hurting, scared or unsafe, or it's about health, legal trouble or lost money — then be steady Bhai.",
};

function composeAddendumContent(p: PersonalityFile): string {
    const body = PRESET_BODIES[p.preset] ?? PRESET_BODIES.casual_playful;
    const lines = ["The user picked how you should sound. Stay Bhai — this is a dial on your character, not a different one.", "", body];
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
    let raw: string;
    try {
        raw = fs.readFileSync(source, "utf-8");
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

    activePreset = parsed.preset;
    const content = composeAddendumContent(parsed);
    const push = await pushToServer(content);
    if (!push.ok) {
        return { ran: false, reason: "push-failed", error: push.error };
    }
    // Rename source → synced marker so the next boot doesn't re-push the
    // same content unless the wizard/Settings UI writes a new file. If the
    // user saved again while we were pushing, leave the new file for the
    // next sync instead of hiding it behind the marker.
    try {
        if (fs.readFileSync(source, "utf-8") !== raw) return { ran: true, reason: "synced", version: push.version };
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

/**
 * Push a new choice as soon as Settings writes it — no restart needed. Watches
 * the folder (the file comes and goes) and syncs on change, debounced.
 * Returns a stop function.
 */
export function watchPersonalityFile(
    dirs: { userDataDir?: string; dataDir?: string },
    onResult?: (r: PersonalitySyncResult) => void,
): () => void {
    const { source } = resolvePersonalityPaths(dirs);
    if (!source || !path.isAbsolute(source)) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const run = async () => {
        if (running || !fs.existsSync(source)) return;
        running = true;
        try {
            const r = await syncPersonalityIfPresent(dirs);
            onResult?.(r);
            // Saved again mid-push: the newer file is still there, sync it too.
            if (r.ran && fs.existsSync(source)) timer = setTimeout(run, 400);
        } finally {
            running = false;
        }
    };
    let watcher: fs.FSWatcher;
    try {
        watcher = fs.watch(path.dirname(source), (_event, name) => {
            if (name !== FILENAME) return;
            clearTimeout(timer);
            timer = setTimeout(run, 400);
        });
    } catch {
        return () => {};
    }
    return () => {
        clearTimeout(timer);
        watcher.close();
    };
}

// ── Per-turn tone reminder ──
// The full preset lives in the server prompt, but at the end of a ~25K-token
// prompt full of default style rules it barely moved replies. A one-line
// restatement next to the user's message (agent.ts, owner turns only) does.
const TONE_REMINDERS: Record<string, string> = {
    professional_concise: "Tone right now: PROFESSIONAL (the user set this in Settings). Answer first, no slang, no emoji, no Hindi catchphrases, no jokes.",
    warm_supportive: "Tone right now: WARM (the user set this in Settings). Acknowledge how they feel before any fix; gentle, patient, no sarcasm or teasing.",
    direct_terse: "Tone right now: DIRECT (the user set this in Settings). Open with the answer or action — no sympathy or acknowledgement first. Two short lines max.",
    unhinged: "Tone right now: UNHINGED, 18+ (the user opted in in Settings). Go full no-filter: swear freely (fuck, shit, damn — and saala, bakchodi, chutiyapa), roast them hard, lots of Hindi slang, dark and absurd jokes, chaotic energy. This overrides your calm, dry defaults. Still never: slurs or hate, mother/sister abuse, harm; drop the act if they're genuinely hurting or it's health, legal or lost money.",
};
let activePreset: string | null = null;

/** Called after boot/sync; reads whichever personality file is present. */
export function loadActivePreset(dirs: { userDataDir?: string; dataDir?: string }): void {
    const { source, marker } = resolvePersonalityPaths(dirs);
    for (const f of [source, marker]) {
        try {
            const p = JSON.parse(fs.readFileSync(f, "utf-8")) as Partial<PersonalityFile>;
            if (typeof p.preset === "string" && Object.hasOwn(PRESET_BODIES, p.preset)) {
                activePreset = p.preset;
                return;
            }
        } catch { /* try the next one */ }
    }
}

/** A short reminder of the user's chosen tone, or null for the default. */
export function getToneReminder(): string | null {
    return activePreset ? (TONE_REMINDERS[activePreset] ?? null) : null;
}
