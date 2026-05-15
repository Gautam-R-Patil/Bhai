// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ForgeTelemetryEvent } from "./types.js";

const DEFAULT_LOG_PATH = join(homedir(), ".atlas", "data", "forge-telemetry.jsonl");

let _logPath: string = DEFAULT_LOG_PATH;
let _eventCount = 0;

export function initForgeTelemetry(path: string = DEFAULT_LOG_PATH): void {
    _logPath = path;
    _eventCount = 0;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function emitForgeEvent(event: ForgeTelemetryEvent): void {
    try {
        const dir = dirname(_logPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(_logPath, JSON.stringify(event) + "\n");
        _eventCount++;
    } catch {
        // never let telemetry crash the agent
    }
}

export function getForgeEventCount(): number {
    return _eventCount;
}

export function getForgeLogPath(): string {
    return _logPath;
}
