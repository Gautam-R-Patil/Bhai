// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../config/paths.js";

let logPathOverride: string | null = null;
let rotationThresholdOverride: number | null = null;

const DEFAULT_ROTATION_BYTES = 10 * 1024 * 1024;

export interface OrchRoutingLog {
    complexity: "simple" | "mild" | "complex";
    model: string;
    shadow: boolean;
    actionCategoryCount: number;
    classifierConfidence: number;
    activeCategories: string[];
    messageLen: number;
    planLatencyMs?: number;
    escalatedToSonnet?: boolean;
}

export function __setRoutingLogPathForTesting(path: string | null): void {
    logPathOverride = path;
}

export function __setRotationThresholdForTesting(bytes: number | null): void {
    rotationThresholdOverride = bytes;
}

function getLogPath(): string {
    if (logPathOverride) return logPathOverride;
    return join(getDataDir(), "orchestrator-routing.jsonl");
}

function getRotationThreshold(): number {
    return rotationThresholdOverride ?? DEFAULT_ROTATION_BYTES;
}

function rotateIfNeeded(path: string): void {
    try {
        if (statSync(path).size >= getRotationThreshold()) {
            renameSync(path, `${path}.1`);
        }
    } catch {
        /* file doesn't exist yet — nothing to rotate */
    }
}

export function logOrchestratorRouting(entry: OrchRoutingLog): void {
    try {
        const path = getLogPath();
        try {
            mkdirSync(dirname(path), { recursive: true });
        } catch {
            /* directory creation may fail when path itself is invalid */
        }
        rotateIfNeeded(path);
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
        appendFileSync(path, `${line}\n`, "utf8");
    } catch {
        /* telemetry must never block planning */
    }
}
