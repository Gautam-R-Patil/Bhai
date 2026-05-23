// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

let auditPathOverride: string | null = null;
let rotationThresholdOverride: number | null = null;

const DEFAULT_ROTATION_BYTES = 10 * 1024 * 1024;

export interface GateDecisionLog {
    decision: "allow" | "reject";
    reason: string;
    source: "user" | "tool" | "reflection" | "consolidation";
    category: string;
    content: string;
}

export function __setAuditPathForTesting(path: string | null): void {
    auditPathOverride = path;
}

export function __setRotationThresholdForTesting(bytes: number | null): void {
    rotationThresholdOverride = bytes;
}

function getAuditPath(): string {
    if (auditPathOverride) return auditPathOverride;
    return join(process.cwd(), "data", "memory-gate.jsonl");
}

function getRotationThreshold(): number {
    return rotationThresholdOverride ?? DEFAULT_ROTATION_BYTES;
}

function sha16(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function rotateIfNeeded(path: string): void {
    try {
        const size = statSync(path).size;
        if (size >= getRotationThreshold()) {
            renameSync(path, `${path}.1`);
        }
    } catch {
        /* file doesn't exist yet — nothing to rotate */
    }
}

export function logGateDecision(entry: GateDecisionLog): void {
    try {
        const path = getAuditPath();
        try {
            mkdirSync(dirname(path), { recursive: true });
        } catch {
            /* directory creation may fail when path itself is invalid */
        }
        rotateIfNeeded(path);
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            decision: entry.decision,
            reason: entry.reason,
            source: entry.source,
            category: entry.category,
            content_preview: entry.content.slice(0, 100),
            sha: sha16(entry.content),
        });
        appendFileSync(path, `${line}\n`, "utf8");
    } catch {
        /* audit failure must never block a gate decision */
    }
}
