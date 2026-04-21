// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Chat-level commands to control the proactive subsystem from any channel.
// Parsed before runAgent() in telegram.ts / whatsapp.ts owner handlers.

import { loadProactiveConfig, setPosture, type Posture } from "./config.js";
import type { Channel } from "./intent.js";

export type CmdResult = { reply: string } | null;

const CHANNELS: Channel[] = [
    "whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay",
];
const POSTURES: Posture[] = ["calm", "active", "ambient"];

export function tryProactiveCommand(
    text: string,
    opts: { configPath: string },
): CmdResult {
    const lower = text.trim().toLowerCase();

    // `shut up` / `atlas shut up` / `atlas, shut up` / `be quiet`
    if (/^(atlas,?\s+)?shut up$/.test(lower) || /^(atlas,?\s+)?be quiet$/.test(lower)) {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        return { reply: "Going quiet. Say 'atlas resume' when you want me back." };
    }

    // `resume` / `atlas resume` / `come back`
    if (/^(atlas,?\s+)?resume$/.test(lower) || /^(atlas,?\s+)?come back$/.test(lower)) {
        delete process.env.ATLAS_PROACTIVE_DISABLE;
        return { reply: "Resuming proactive messages." };
    }

    // `set <channel> to <preset>` / `atlas set ...` / `atlas, set ...`
    const setMatch = lower.match(/^(atlas,?\s+)?set\s+(\w+)\s+to\s+(\w+)$/);
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

    // `proactive status` / `atlas proactive status`
    if (/^(atlas,?\s+)?proactive\s+status$/.test(lower)) {
        const cfg = loadProactiveConfig(opts.configPath);
        const lines = ["Current postures:"];
        for (const ch of CHANNELS) {
            lines.push(`- ${ch}: ${cfg.postures[ch]}`);
        }
        if (process.env.ATLAS_PROACTIVE_DISABLE === "true") {
            lines.push("");
            lines.push("Proactive messages are globally disabled right now. Say 'atlas resume' to re-enable.");
        }
        return { reply: lines.join("\n") };
    }

    return null;
}
