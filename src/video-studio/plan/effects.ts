// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export type EffectDirective =
    | { kind: "bg_replace"; asset: string }
    | { kind: "color_grade"; preset: string }
    | { kind: "stabilize" }
    | { kind: "stylize"; preset: string };

const PAYLOAD_KINDS = new Set(["bg_replace", "color_grade", "stylize"] as const);
type PayloadKind = "bg_replace" | "color_grade" | "stylize";

const NO_PAYLOAD_KINDS = new Set(["stabilize"] as const);

export function parseEffect(raw: string): EffectDirective | null {
    if (!raw) return null;

    const colonIdx = raw.indexOf(":");
    const kind = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
    const payload = colonIdx === -1 ? "" : raw.slice(colonIdx + 1);

    if (NO_PAYLOAD_KINDS.has(kind as "stabilize")) {
        if (payload !== "") return null;
        return { kind: "stabilize" };
    }

    if (PAYLOAD_KINDS.has(kind as PayloadKind)) {
        if (!payload) return null;

        if (kind === "bg_replace") {
            return { kind: "bg_replace", asset: payload };
        }
        if (kind === "color_grade") {
            return { kind: "color_grade", preset: payload };
        }
        if (kind === "stylize") {
            return { kind: "stylize", preset: payload };
        }
    }

    return null;
}
