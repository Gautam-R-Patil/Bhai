// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Once-a-day work that survives restarts. The sources' native gate is an hour, in
// memory: a morning source fetched news or weather (web searches + LLM calls) every
// hour and after every restart, though the topic dedup let only the first one out.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../../../config/paths.js";

const file = () => join(getDataDir(), "proactive-daily.json");
const localDay = (now: number) => new Date(now).toLocaleDateString("sv"); // YYYY-MM-DD, this machine's day

function read(): Record<string, string> {
    try {
        return JSON.parse(readFileSync(file(), "utf8")) as Record<string, string>;
    } catch {
        return {};
    }
}

/** Did `name` already finish today (this machine's day)? */
export function doneToday(name: string, now: number): boolean {
    return read()[name] === localDay(now);
}

/** Record that `name` finished today. Best-effort: a failed write means one more run. */
export function markDoneToday(name: string, now: number): void {
    try {
        mkdirSync(getDataDir(), { recursive: true });
        const tmp = `${file()}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...read(), [name]: localDay(now) }));
        renameSync(tmp, file());
    } catch {
        /* data dir unwritable: the topic dedup still keeps it to one message */
    }
}
