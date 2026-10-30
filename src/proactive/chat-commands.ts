// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Chat-level commands to control the proactive subsystem from any channel.
// Parsed before runAgent() in telegram.ts / whatsapp.ts owner handlers.
//
// Two groups:
//   1) Posture / silence controls (sync, no external deps):
//        - "shut up" / "be quiet"
//        - "resume" / "come back"
//        - "set <channel> to <preset>"
//        - "proactive status"
//   2) Monitor-rule CRUD (async, needs MonitorStore + NL parser + native
//      module — opts.monitorStore / parseRule / nativeMonitor):
//        - "ping me if <phrase>" / "monitor me when <phrase>" /
//          "alert me if <phrase>" / "watch for <phrase>"
//        - "list monitors" / "show monitors"
//        - "delete monitor <N|uuid>" / "stop monitor <N>" /
//          "remove monitor <N>"
//        - "pause monitor <N>" / "resume monitor <N>"
//
// If the monitor opts are absent, monitor commands return null so the caller
// falls through to runAgent — keeps tests that only exercise the posture
// commands from needing to wire the new deps.

import { loadProactiveConfig, setPosture, setQuiet, type Posture } from "./config.js";
import type { Channel } from "./intent.js";
import { clearQuiet } from "./kill-switches.js";
import type { MonitorRule, MonitorStore } from "./monitors/monitor-store.js";
import type { ParseResult } from "./monitors/monitor-parser.js";

export type CmdResult = { reply: string } | null;

export type MonitorRuleRust = {
    id: string;
    topicEmbedding: number[];
    scopeChannels: string[];
    scopeSenders?: string[];
    excludeSelf: boolean;
    threshold: number;
    cooldownMinutes: number;
    active: boolean;
    lastFiredAt: number;
};

export type ProactiveCommandOpts = {
    configPath: string;
    // Monitor CRUD deps — all optional. If any is missing, monitor commands
    // return null (caller should fall through to runAgent).
    monitorStore?: MonitorStore;
    parseRule?: (userPhrase: string) => Promise<ParseResult>;
    nativeMonitor?: {
        upsertRule: (r: MonitorRuleRust) => void;
        deleteRule: (id: string) => void;
    };
};

const CHANNELS: Channel[] = [
    "whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay",
];
const POSTURES: Posture[] = ["calm", "active", "ambient"];

// UUID shape emitted by randomUUID() — 8-4-4-4-12 hex with hyphens.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function tryProactiveCommand(
    text: string,
    opts: ProactiveCommandOpts,
): Promise<CmdResult> {
    const lower = text.trim().toLowerCase();

    // ── Posture commands (sync) ───────────────────────────

    // `shut up` / `bhai shut up` / `bhai, shut up` / `be quiet`
    if (/^(bhai,?\s+)?shut up$/.test(lower) || /^(bhai,?\s+)?be quiet$/.test(lower)) {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        try {
            setQuiet(opts.configPath, true); // survives a restart (it used to resume on its own)
        } catch {
            /* still quiet for this run */
        }
        return { reply: "Going quiet. Say 'bhai resume' when you want me back." };
    }

    // `resume` / `bhai resume` / `come back` — but be careful: "resume monitor N"
    // also starts with "resume" and must fall through to the monitor handler below.
    if (
        (/^(bhai,?\s+)?resume$/.test(lower) || /^(bhai,?\s+)?come back$/.test(lower))
        && !/^(bhai,?\s+)?resume\s+monitor/i.test(lower)
    ) {
        delete process.env.ATLAS_PROACTIVE_DISABLE;
        clearQuiet(); // a "not now" or serious-moment hold too
        try {
            setQuiet(opts.configPath, false);
        } catch {
            /* resumed for this run */
        }
        return { reply: "Resuming proactive messages." };
    }

    // `set <channel> to <preset>`
    const setMatch = lower.match(/^(bhai,?\s+)?set\s+(\w+)\s+to\s+(\w+)$/);
    if (setMatch) {
        const [, , ch, preset] = setMatch;
        if (!CHANNELS.includes(ch as Channel)) {
            return { reply: `Unknown channel: ${ch}. Options: ${CHANNELS.join(", ")}.` };
        }
        if (!POSTURES.includes(preset as Posture)) {
            return { reply: `Unknown preset: ${preset}. Options: ${POSTURES.join(", ")}.` };
        }
        const cfg = loadProactiveConfig(opts.configPath);
        setPosture(cfg, ch as Channel, preset as Posture, opts.configPath);
        return { reply: `Got it — ${ch} is now on ${preset} posture.` };
    }

    // `proactive stats` — telemetry rollup (Phase 5.2). Must appear BEFORE
    // `proactive status` so the more specific pattern wins (neither regex
    // matches the other's text, but keeping the order consistent with the
    // spec avoids future regressions if the patterns loosen).
    if (/^(bhai,?\s+)?proactive\s+stats$/.test(lower)) {
        // Lazy-import telemetry so this command is callable in tests without deps.
        const { getTelemetry } = await import("./telemetry.js");
        const tl = getTelemetry();
        if (!tl) {
            return { reply: "Telemetry not initialized — stats unavailable." };
        }
        const since = Date.now() - 7 * 86_400_000;  // 7 days
        const stats = tl.statsBySourceChannel(since);
        if (stats.length === 0) {
            return { reply: "No proactive activity in the last 7 days." };
        }
        const lines = ["Proactive stats (last 7d):"];
        for (const s of stats) {
            const dispatched = s.dispatched;
            const dropPct = Math.round(s.dropRate * 100);
            lines.push(`- ${s.source}/${s.channel}: ${dispatched} dispatched, ${dropPct}% dropped`);
        }
        return { reply: lines.join("\n") };
    }

    // `proactive status`
    if (/^(bhai,?\s+)?proactive\s+status$/.test(lower)) {
        const cfg = loadProactiveConfig(opts.configPath);
        const lines = ["Current postures:"];
        for (const ch of CHANNELS) {
            lines.push(`- ${ch}: ${cfg.postures[ch]}`);
        }
        if (process.env.ATLAS_PROACTIVE_DISABLE === "true") {
            lines.push("");
            lines.push(
                "Proactive messages are globally disabled right now. Say 'bhai resume' to re-enable.",
            );
        }
        return { reply: lines.join("\n") };
    }

    // ── Monitor CRUD commands (async) ─────────────────────

    // Create: "(bhai,)? (ping me if|monitor me when|alert me if|watch for) <phrase>"
    const createMatch = text
        .trim()
        .match(/^(?:bhai,?\s+)?(?:ping me if|monitor me when|alert me if|watch for)\s+(.+)$/i);
    if (createMatch) {
        return handleCreate(createMatch[1].trim(), opts);
    }

    // List
    if (/^(bhai,?\s+)?(?:list|show)\s+monitors?$/i.test(text.trim())) {
        return handleList(opts);
    }

    // Delete: "(bhai,)? (delete|stop|remove) monitor <N|uuid>"
    const deleteMatch = text
        .trim()
        .match(/^(?:bhai,?\s+)?(?:delete|stop|remove)\s+monitor\s+(\S+)$/i);
    if (deleteMatch) {
        return handleDelete(deleteMatch[1], opts);
    }

    // Pause: "(bhai,)? pause monitor <N|uuid>"
    const pauseMatch = text
        .trim()
        .match(/^(?:bhai,?\s+)?pause\s+monitor\s+(\S+)$/i);
    if (pauseMatch) {
        return handleSetActive(pauseMatch[1], false, opts);
    }

    // Resume: "(bhai,)? resume monitor <N|uuid>"
    const resumeMatch = text
        .trim()
        .match(/^(?:bhai,?\s+)?resume\s+monitor\s+(\S+)$/i);
    if (resumeMatch) {
        return handleSetActive(resumeMatch[1], true, opts);
    }

    return null;
}

// ── Monitor handler helpers ───────────────────────────

async function handleCreate(phrase: string, opts: ProactiveCommandOpts): Promise<CmdResult> {
    if (!opts.monitorStore || !opts.parseRule || !opts.nativeMonitor) {
        // Monitor deps not wired — let the regular agent handle it
        return null;
    }

    let result: ParseResult;
    try {
        result = await opts.parseRule(phrase);
    } catch (err) {
        return { reply: `Sorry, I couldn't parse that monitor: ${(err as Error).message}` };
    }

    if (result.kind === "clarify") {
        return { reply: result.question };
    }
    if (result.kind === "error") {
        return { reply: `Sorry, I couldn't parse that monitor: ${result.error}` };
    }

    let rule: MonitorRule;
    try {
        rule = opts.monitorStore.insert(result.input);
    } catch (err) {
        return { reply: `Couldn't save that monitor: ${(err as Error).message}` };
    }

    // Push to native matcher so it's live immediately
    try {
        opts.nativeMonitor.upsertRule(ruleToRust(rule));
    } catch (err) {
        // Non-fatal: rule is persisted, will load on next boot
        console.log(
            "[chat-commands] monitor native upsert failed (non-fatal):",
            (err as Error).message,
        );
    }

    const count = opts.monitorStore.list(true).length;
    return {
        reply: `Got it — monitor #${count}: "${rule.topic}". I'll ping you when I see a match.`,
    };
}

function handleList(opts: ProactiveCommandOpts): CmdResult {
    if (!opts.monitorStore) return null;
    // Use the store's native order (created_at DESC; ties break on rowid).
    // Whatever order list(false) produces is what `delete/pause/resume N`
    // targets — the two must agree, and both go through the same call.
    const rules = opts.monitorStore.list(false);
    if (rules.length === 0) {
        return {
            reply: "No monitors set up yet. Try: \"ping me if anyone mentions the project launch\".",
        };
    }
    const lines = ["Your monitors:"];
    rules.forEach((r, i) => {
        const status = r.active ? "active" : "paused";
        lines.push(`${i + 1}. ${r.topic} [${status}]`);
    });
    return { reply: lines.join("\n") };
}

function resolveRuleByNOrId(arg: string, opts: ProactiveCommandOpts): MonitorRule | null {
    if (!opts.monitorStore) return null;
    // UUID path
    if (UUID_RE.test(arg)) {
        return opts.monitorStore.get(arg);
    }
    // Numeric path — must use the same ordering as `handleList`.
    const n = Number.parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    const rules = opts.monitorStore.list(false);
    if (n > rules.length) return null;
    return rules[n - 1];
}

function handleDelete(arg: string, opts: ProactiveCommandOpts): CmdResult {
    if (!opts.monitorStore || !opts.nativeMonitor) return null;
    const rule = resolveRuleByNOrId(arg, opts);
    if (!rule) {
        return { reply: `No monitor found for "${arg}". Try "list monitors" to see them.` };
    }
    opts.monitorStore.softDelete(rule.id);
    try {
        opts.nativeMonitor.deleteRule(rule.id);
    } catch (err) {
        console.log(
            "[chat-commands] monitor native delete failed (non-fatal):",
            (err as Error).message,
        );
    }
    return { reply: `Deleted monitor "${rule.topic}".` };
}

function handleSetActive(
    arg: string,
    active: boolean,
    opts: ProactiveCommandOpts,
): CmdResult {
    if (!opts.monitorStore || !opts.nativeMonitor) return null;
    const rule = resolveRuleByNOrId(arg, opts);
    if (!rule) {
        return { reply: `No monitor found for "${arg}". Try "list monitors" to see them.` };
    }
    opts.monitorStore.setActive(rule.id, active);
    try {
        if (active) {
            opts.nativeMonitor.upsertRule(ruleToRust({ ...rule, active: true }));
        } else {
            opts.nativeMonitor.deleteRule(rule.id);
        }
    } catch (err) {
        console.log(
            "[chat-commands] monitor native sync failed (non-fatal):",
            (err as Error).message,
        );
    }
    const verb = active ? "Resumed" : "Paused";
    return { reply: `${verb} monitor "${rule.topic}".` };
}

export function ruleToRust(rule: MonitorRule): MonitorRuleRust {
    return {
        id: rule.id,
        topicEmbedding: rule.topicEmbedding,
        scopeChannels: [...rule.scope.channels],
        scopeSenders: rule.scope.senders && rule.scope.senders.length > 0
            ? [...rule.scope.senders]
            : undefined,
        excludeSelf: rule.scope.excludeSelf,
        threshold: rule.threshold,
        cooldownMinutes: rule.cooldownMinutes,
        active: rule.active,
        lastFiredAt: rule.lastFiredAt,
    };
}
