// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── System Resource Monitoring ───────────────
// Lightweight cross-platform utility for determining safe parallelism limits.
// Uses only node:os — zero external dependencies.

import os from "node:os";

export interface ResourceLimits {
    maxParallelTabs: number;
    freeMemoryMB: number;
    cpuCount: number;
    reason: string;
}

// Each Chromium tab uses roughly 80-150MB
const ESTIMATED_TAB_MEMORY_MB = 120;
// Reserve this much for the OS, Node process, and other subsystems
const RESERVED_MEMORY_MB = 1024;
// Hard ceiling regardless of resources
const ABSOLUTE_MAX_TABS = 8;
// Floor: always allow at least this many
const ABSOLUTE_MIN_TABS = 2;

export function getResourceLimits(): ResourceLimits {
    const freeMemMB = Math.round(os.freemem() / (1024 * 1024));
    const cpuCount = os.cpus().length;

    const availableForTabs = Math.max(0, freeMemMB - RESERVED_MEMORY_MB);
    const memoryBasedLimit = Math.floor(availableForTabs / ESTIMATED_TAB_MEMORY_MB);

    // No point opening more tabs than CPU cores minus one (for the main process)
    const cpuBasedLimit = Math.max(2, cpuCount - 1);

    const maxParallelTabs = Math.max(
        ABSOLUTE_MIN_TABS,
        Math.min(ABSOLUTE_MAX_TABS, memoryBasedLimit, cpuBasedLimit)
    );

    const reason = `Free RAM: ${freeMemMB}MB, CPUs: ${cpuCount}, tab limit: ${maxParallelTabs}`;
    return { maxParallelTabs, freeMemoryMB: freeMemMB, cpuCount, reason };
}
