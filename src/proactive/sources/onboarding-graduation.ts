// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// W3 Adaptive Nudges — three day-gated graduation messages that fire from
// the existing proactive engine on Day-2 / Day-3 / Day-5 after first install.
//
// Persistence: nudge state lives in identity.extra.onboardingNudges so it
// survives bot restarts. Bot reads on boot, writes after each fire. The
// firstLaunchAt seed is set when wizard-seed runs (post-W2) — it's the
// timestamp on .user-profile.seeded.json, which we read once.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    type ProactiveIntent,
    makeIntentId,
    type IntentSource,
} from "../intent.js";
import type { IntentSourceModule, SourceCtx } from "./source.js";
import { getIdentityProfile, updateIdentityProfile } from "../../memory/identity.js";

const SOURCE_NAME: IntentSource = "onboarding_graduation";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Nudge catalogue ──────────────────────────────────────────────
// Order matters: each nudge has a day-gate floor (must be ≥N days
// since firstLaunch). The first-eligible-and-unfired wins.

type NudgeId = "personalize-shortcuts" | "browser-memory" | "voice-speed";

interface NudgeDef {
    id: NudgeId;
    daysSinceLaunch: number;
    bodyTemplate: string;             // {hotkey} substituted at fire time
    actionLabel: string;
    actionPayload: Record<string, unknown>;
}

const NUDGES: NudgeDef[] = [
    {
        id: "personalize-shortcuts",
        daysSinceLaunch: 2,
        bodyTemplate: "I noticed you've been using {hotkey} a lot. Want me to personalize shortcuts based on your workflow?",
        actionLabel: "Personalize",
        actionPayload: { kind: "open_wizard_step", step: "personalize" },
    },
    {
        id: "browser-memory",
        daysSinceLaunch: 3,
        bodyTemplate: "You spend a lot of time in your browser. Want me to remember the tabs you keep open?",
        actionLabel: "Enable browser memory",
        actionPayload: { kind: "toggle_setting", setting: "browserMemory.enabled", value: true },
    },
    {
        id: "voice-speed",
        daysSinceLaunch: 5,
        bodyTemplate: "Want faster voice responses? I can switch to a leaner backend.",
        actionLabel: "Open voice picker",
        actionPayload: { kind: "open_wizard_step", step: "personalize" },
    },
];

// ── State (persisted in identity.extra.onboardingNudges) ─────────

interface NudgeRecord {
    firedAt: number;
    acted?: boolean;
}

interface NudgeState {
    firstLaunchAt?: number;
    graduatedAt?: number;
    nudges: Partial<Record<NudgeId, NudgeRecord>>;
}

function readState(): NudgeState {
    try {
        const profile = getIdentityProfile() as { extra?: { onboardingNudges?: NudgeState } };
        return profile?.extra?.onboardingNudges || { nudges: {} };
    } catch {
        return { nudges: {} };
    }
}

function writeState(next: NudgeState): void {
    try {
        const profile = getIdentityProfile() as { extra?: Record<string, unknown> };
        const extra = profile?.extra || {};
        updateIdentityProfile({ extra: Object.assign({}, extra, { onboardingNudges: next }) });
    } catch {
        /* best-effort */
    }
}

// ── First-launch resolution ──────────────────────────────────────
// Use the .user-profile.seeded.json marker's mtime as a proxy for
// "wizard completed first install" — the wizard-seed module renames
// .user-profile.json → .user-profile.seeded.json on first successful
// seed, and never touches it again. That mtime is essentially
// "first time the bot booted with a real profile".

function resolveFirstLaunchAt(state: NudgeState, userDataDir?: string): number | null {
    if (state.firstLaunchAt) return state.firstLaunchAt;
    if (!userDataDir) return null;
    try {
        const marker = path.join(userDataDir, ".user-profile.seeded.json");
        if (fs.existsSync(marker)) {
            return fs.statSync(marker).mtimeMs;
        }
    } catch {
        /* nothing useful — leave it null */
    }
    return null;
}

// ── Decision logic ───────────────────────────────────────────────

interface DecideOpts {
    now: number;
    state: NudgeState;
    firstLaunchAt: number | null;
    /** When true, skip telemetry gates (used by tests to force-fire). */
    skipTelemetryGates?: boolean;
    /** Override hook for test injection. Returns true if a counter is high enough. */
    telemetryCheck?: (nudgeId: NudgeId) => boolean;
}

export interface NudgeDecision {
    nudgeId: NudgeId | null;
    reason: "no-launch-yet" | "too-early" | "all-fired" | "graduated" | "ok" | "telemetry-gate";
}

export function decideNudge(opts: DecideOpts): NudgeDecision {
    if (opts.state.graduatedAt) return { nudgeId: null, reason: "graduated" };
    if (opts.firstLaunchAt == null) return { nudgeId: null, reason: "no-launch-yet" };

    const daysSinceLaunch = Math.floor((opts.now - opts.firstLaunchAt) / MS_PER_DAY);

    for (const def of NUDGES) {
        if (opts.state.nudges[def.id]) continue; // already fired
        if (daysSinceLaunch < def.daysSinceLaunch) continue;
        if (!opts.skipTelemetryGates && opts.telemetryCheck && !opts.telemetryCheck(def.id)) {
            return { nudgeId: null, reason: "telemetry-gate" };
        }
        return { nudgeId: def.id, reason: "ok" };
    }

    // None eligible → could be "too-early" or "all-fired".
    if (Object.keys(opts.state.nudges).length >= NUDGES.length) {
        return { nudgeId: null, reason: "all-fired" };
    }
    return { nudgeId: null, reason: "too-early" };
}

// ── Intent builder ───────────────────────────────────────────────

interface BuildOpts {
    nudge: NudgeDef;
    hotkey?: string;
    now: number;
    /** Pre-computed onboarding embedding (length 384). */
    embedding: number[];
}

export function buildIntent(opts: BuildOpts): ProactiveIntent {
    const body = opts.nudge.bodyTemplate.replace("{hotkey}", opts.hotkey || "Alt+Space");
    return {
        id: makeIntentId(SOURCE_NAME),
        source: SOURCE_NAME,
        mode: "question",
        urgency: "ambient",
        channelPreference: "overlay",
        topic: `Onboarding graduation — ${opts.nudge.id}`,
        topicEmbedding: opts.embedding,
        evidence: [
            { label: "nudge_id", value: opts.nudge.id, source: "onboarding-graduation" },
            { label: "days_since_launch", value: "≥" + String(opts.nudge.daysSinceLaunch), source: "onboarding-graduation" },
        ],
        payload: {
            kind: "onboarding_graduation",
            nudgeId: opts.nudge.id,
            body: body,
            actionLabel: opts.nudge.actionLabel,
            actionPayload: opts.nudge.actionPayload,
        },
        suggestedAction: {
            toolCalls: [],   // No tool call — the renderer handles the click directly.
            summary: opts.nudge.actionLabel,
        },
        createdAt: opts.now,
        expiresAt: opts.now + 7 * MS_PER_DAY,
    };
}

// ── The IntentSourceModule itself ────────────────────────────────

let _onboardingEmbedding: number[] | null = null;

async function getOnboardingEmbedding(): Promise<number[]> {
    if (_onboardingEmbedding) return _onboardingEmbedding;
    try {
        const { embedText } = await import("../../memory/embeddings.js");
        const e = await embedText("onboarding graduation wizard nudge");
        _onboardingEmbedding = Array.from(e);
        return _onboardingEmbedding;
    } catch {
        // Fallback: a deterministic zero-ish vector. validateIntent requires
        // length 384; zeros are fine (they'll never match anything semantic,
        // which is the correct behaviour for ambient meta-messages).
        _onboardingEmbedding = new Array(384).fill(0);
        return _onboardingEmbedding;
    }
}

function userDataDirGuess(): string | undefined {
    // The bot runs inside the packaged Electron app and is spawned with
    // BHAI_USER_DATA_DIR set. Falls back to undefined in pure-Node tests.
    return process.env.BHAI_USER_DATA_DIR;
}

export const onboardingGraduationSource: IntentSourceModule = {
    name: SOURCE_NAME,
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        // W3 dedicated kill-switch (in addition to the existing
        // BHAI_PROACTIVE_DISABLE_SOURCES=onboarding_graduation path).
        if (process.env.BHAI_NO_ONBOARDING_NUDGES === "true") return [];

        const state = readState();
        const firstLaunchAt = resolveFirstLaunchAt(state, userDataDirGuess());
        const decision = decideNudge({ now: ctx.now, state, firstLaunchAt });
        if (decision.nudgeId == null) return [];

        const def = NUDGES.find((n) => n.id === decision.nudgeId);
        if (!def) return [];

        const embedding = await getOnboardingEmbedding();
        const profile = getIdentityProfile() as { extra?: { hotkey?: string } };
        const hotkey = profile?.extra?.hotkey;

        const intent = buildIntent({ nudge: def, hotkey, now: ctx.now, embedding });

        // Persist: mark fired BEFORE returning so a duplicate collectIntents
        // call (e.g. from a fast poll) doesn't double-emit.
        const nextState: NudgeState = {
            ...state,
            firstLaunchAt: firstLaunchAt || state.firstLaunchAt,
            nudges: { ...state.nudges, [def.id]: { firedAt: ctx.now } },
        };
        // If this was the last nudge, mark graduated.
        if (Object.keys(nextState.nudges).length >= NUDGES.length) {
            nextState.graduatedAt = ctx.now;
        }
        writeState(nextState);

        return [intent];
    },
};

// ── Exports for tests ────────────────────────────────────────────
export const _internals = {
    NUDGES,
    SOURCE_NAME,
    MS_PER_DAY,
    readState,
    writeState,
    resolveFirstLaunchAt,
    buildIntent,
    decideNudge,
};
