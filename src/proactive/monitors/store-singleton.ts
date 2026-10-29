// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Process-global MonitorStore handle. Set once at boot (see src/index.ts
// Observer bootstrap) and read from anywhere — channel receive paths and
// chat-commands in particular — without threading the store through every
// call chain.

import type { MonitorStore } from "./monitor-store.js";

let _store: MonitorStore | null = null;

export function getMonitorStore(): MonitorStore | null {
    return _store;
}

export function setMonitorStore(s: MonitorStore | null): void {
    _store = s;
}
