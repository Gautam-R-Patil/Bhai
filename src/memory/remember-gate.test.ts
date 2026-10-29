// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// remember(): shadow mode must still drop hard rejects, and every stored row
// starts at decay_score 1.0 (the old surprise gate stored up to 1.5).
// Identity: the device location never overwrites the home the user stated.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-remember-gate-"));
process.env.ATLAS_MEMORY_GATE_SHADOW = "true";
delete process.env.ATLAS_NO_MEMORY_GATE;

const sqlite = await import("./sqlite.js");
const identity = await import("./identity.js");
const req = createRequire(import.meta.url);

// The better-sqlite3 binding isn't built for every local Node; CI has it.
let hasBinding = false;
try {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    new BetterSqlite3(":memory:").close();
    hasBinding = true;
} catch {
    /* no native binding */
}

describe.skipIf(!hasBinding)("remember() with the real DB", () => {
    beforeAll(async () => {
        await sqlite.initMemoryDB();
    });

    const row = (id: number) =>
        sqlite.getRawDb()?.prepare("SELECT importance, decay_score FROM memories WHERE id = ?").get(id) as
            | { importance: number; decay_score: number }
            | undefined;

    it("drops hard rejects even in shadow mode", async () => {
        expect(await sqlite.remember("x".repeat(2500), "fact")).toBeNull(); // oversize
        expect(await sqlite.remember('{"screenshot_base64":"AAAA"} note', "fact")).toBeNull(); // binary
    });

    it("stores routine and important memories at decay_score 1.0", async () => {
        const five = await sqlite.remember("User likes green tea in the morning", "preference", "", 5);
        const seven = await sqlite.remember("User is allergic to peanuts", "fact", "", 7);
        expect(row(five as number)?.decay_score).toBe(1);
        expect(row(seven as number)?.decay_score).toBe(1);
        expect(row(seven as number)?.importance).toBeGreaterThan(row(five as number)?.importance ?? 99);
    });

    it("reinforces an exact duplicate instead of storing a second row", async () => {
        const a = await sqlite.remember("User drives a blue Honda City", "fact");
        const b = await sqlite.remember("user drives a blue Honda city.", "fact");
        expect(b).toBe(a);
        const rows = sqlite.getRawDb()?.prepare("SELECT id FROM memories WHERE content LIKE '%Honda%'").all();
        expect(rows).toHaveLength(1);
    });
});

let DatabaseSync: (new (p: string) => { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[]; run(...a: unknown[]): unknown } }) | undefined;
try {
    DatabaseSync = req("node:sqlite").DatabaseSync;
} catch {
    /* older Node */
}

it.skipIf(!DatabaseSync)("keeps the stated home when the device location changes", () => {
    const raw = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
    const db = {
        run: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...params),
        exec: (sql: string, params: unknown[] = []) => {
            const r = raw.prepare(sql).all(...params);
            return r.length ? [{ columns: Object.keys(r[0]), values: r.map((x) => Object.values(x)) }] : [];
        },
    };
    identity.initIdentityDB(db as never);
    identity.updateIdentityProfile({ location: { value: "Pune, India", verified: true } });
    identity.updateIdentityProfile({ current_location: "Goa, India" });
    const p = identity.getIdentityProfile();
    expect(identity.getFieldValue(p.location)).toBe("Pune, India");
    expect(p.current_location).toBe("Goa, India");
});
