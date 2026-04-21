// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSource, Channel } from "./intent.js";

function isTrue(v: string | undefined): boolean {
    return v === "true" || v === "1";
}

function parseCsv(v: string | undefined): Set<string> {
    if (!v) return new Set();
    return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

export function isProactiveDisabled(): boolean {
    return isTrue(process.env.ATLAS_PROACTIVE_DISABLE);
}

export function isSourceDisabled(src: IntentSource): boolean {
    return parseCsv(process.env.ATLAS_PROACTIVE_DISABLE_SOURCES).has(src);
}

export function isChannelDisabled(ch: Channel): boolean {
    return parseCsv(process.env.ATLAS_PROACTIVE_DISABLE_CHANNELS).has(ch);
}

export function isShadowMode(): boolean {
    return isTrue(process.env.ATLAS_PROACTIVE_SHADOW);
}

export function debugProactive(event: string, ctx: Record<string, unknown>): void {
    if (process.env.ATLAS_PROACTIVE_DEBUG === "false") return;
    const flat = Object.entries(ctx)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
    console.log(`🔔 [proactive] ${event} | ${flat}`);
}
