// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import type { Channel } from "./intent.js";

export type Posture = "calm" | "active" | "ambient";
export type ProactiveConfig = {
    postures: Record<Channel, Posture>;
    urgentAllowedAfter: string;            // "HH:MM"
    nightWindows: { default: { start: string; end: string } };
};

const VALID_CHANNELS: Channel[] = [
    "whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay",
];
const VALID_POSTURES: Posture[] = ["calm", "active", "ambient"];

const DEFAULTS: ProactiveConfig = {
    postures: {
        whatsapp: "calm",
        telegram: "active",
        overlay: "ambient",
        discord: "calm",
        slack: "calm",
        matrix: "calm",
        email: "ambient",
    },
    urgentAllowedAfter: "07:00",
    nightWindows: { default: { start: "22:30", end: "07:00" } },
};

export function loadProactiveConfig(path: string): ProactiveConfig {
    if (!existsSync(path)) return structuredClone(DEFAULTS);
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        return {
            ...DEFAULTS,
            ...raw,
            postures: { ...DEFAULTS.postures, ...(raw.postures ?? {}) },
        };
    } catch {
        return structuredClone(DEFAULTS);
    }
}

export function getPosture(cfg: ProactiveConfig, ch: Channel): Posture {
    return cfg.postures[ch] ?? "calm";
}

export function setPosture(
    cfg: ProactiveConfig,
    channel: Channel,
    preset: Posture,
    path: string,
): void {
    if (!VALID_CHANNELS.includes(channel)) {
        throw new Error(`unknown channel: ${channel}`);
    }
    if (!VALID_POSTURES.includes(preset)) {
        throw new Error(`unknown preset: ${preset}`);
    }
    // Atomic write: build next state, write to tmp, rename into place, THEN
    // mutate the caller's cfg. A crash before rename leaves the old file intact;
    // a throw from writeFileSync never reaches the in-memory mutation.
    const next: ProactiveConfig = {
        ...cfg,
        postures: { ...cfg.postures, [channel]: preset },
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    cfg.postures[channel] = preset;
}

export const POSTURE_PARAMS: Record<Posture, {
    maxPerDay: number;
    minGapMin: number;
    heartbeatMin: number;
    boundaryOnly: boolean;
    urgentBypass: boolean;
}> = {
    calm:    { maxPerDay: 3, minGapMin: 120, heartbeatMin: 120, boundaryOnly: true,  urgentBypass: true },
    active:  { maxPerDay: 8, minGapMin: 45,  heartbeatMin: 60,  boundaryOnly: false, urgentBypass: true },
    ambient: { maxPerDay: 1, minGapMin: 360, heartbeatMin: 240, boundaryOnly: true,  urgentBypass: true },
};
