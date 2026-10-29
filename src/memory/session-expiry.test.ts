// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A session that timed out while Bhai was not running is still handed on for reflection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-session-expiry-"));
const sqlite = await import("./sqlite.js");
await sqlite.initMemoryDB();
const { touchSession } = await import("./session.js");

it("reflects a session that expired across a restart, and prunes old sessions", () => {
    const raw = sqlite.getRawDb();
    if (!raw) throw new Error("raw DB unavailable");
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const ins = raw.prepare(
        "INSERT INTO sessions (session_id, current_goal, started_at, last_activity, turn_count, short_summary, recent_turns_json, last_compression_summary) VALUES (?, '', ?, ?, ?, '', '[]', '')",
    );
    ins.run("ancient", ago(30 * 86400_000), ago(30 * 86400_000), 9);
    ins.run("last-night", ago(10 * 3600_000), ago(9 * 3600_000), 6);

    const { isNew, expiredSession } = touchSession("good morning");
    expect(isNew).toBe(true);
    expect(expiredSession).toMatchObject({ session_id: "last-night", turn_count: 6 });
    const ids = (raw.prepare("SELECT session_id FROM sessions").all() as Array<{ session_id: string }>).map((r) => r.session_id);
    expect(ids).not.toContain("ancient");
    expect(ids).toContain("last-night");
});
