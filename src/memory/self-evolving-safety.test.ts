// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deletes on memories really happen now, so the nightly prune must never
// remove important or never-recalled memories, nor more than a tenth at once.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { synapticPrune } from "./self-evolving.js";

type Row = Record<string, unknown>;
let DatabaseSync: (new (p: string) => { exec(s: string): void; prepare(s: string): { all(...a: unknown[]): Row[]; run(...a: unknown[]): unknown } }) | undefined;
try {
    DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
    /* older Node */
}

function makeDb(rows: Array<[number, number, number, number]>) {
    const raw = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
    raw.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, importance REAL, access_count INT, decay_score REAL,
              accessed_at TEXT, created_at TEXT, consolidated_into INT, pinned INT, category TEXT)`);
    raw.exec("CREATE TABLE memory_embeddings (memory_id INTEGER PRIMARY KEY, embedding BLOB)");
    for (const [id, importance, access, daysAgo] of rows) {
        raw.prepare(`INSERT INTO memories VALUES (?, ?, ?, 1.0, NULL, datetime('now', ?), NULL, 0, 'fact')`).run(id, importance, access, `-${daysAgo} days`);
    }
    // The sql.js-style surface synapticPrune uses.
    const db = {
        exec: (sql: string, params: unknown[] = []) => {
            const r = raw.prepare(sql).all(...params);
            return r.length ? [{ columns: Object.keys(r[0]), values: r.map((x) => Object.values(x)) }] : [];
        },
        run: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...params),
    };
    const ids = () => raw.prepare("SELECT id FROM memories ORDER BY id").all().map((r) => r.id as number);
    const decay = (id: number) => raw.prepare("SELECT decay_score FROM memories WHERE id = ?").all(id)[0]?.decay_score as number;
    const setDecay = (id: number, v: number) => raw.prepare("UPDATE memories SET decay_score = ? WHERE id = ?").run(v, id);
    return { db, ids, decay, setDecay };
}

describe.skipIf(!DatabaseSync)("synaptic prune safety", () => {
    it("keeps important and never-recalled memories; removes at most a tenth per pass", () => {
        const rows: Array<[number, number, number, number]> = [];
        // 30 well-used memories, 10 weak low-importance ones, 1 important never-recalled one.
        for (let i = 1; i <= 30; i++) rows.push([i, 5, 20, 1]);
        for (let i = 31; i <= 40; i++) rows.push([i, 1, 1, 120]);
        rows.push([41, 10, 0, 30]);
        const { db, ids } = makeDb(rows);
        const r = synapticPrune(db as never);
        expect(r.pruned).toBe(Math.floor(41 * 0.1)); // 10 weak candidates, capped at 4
        expect(ids()).toHaveLength(41 - r.pruned);
        expect(ids()).toContain(41);
        for (let i = 1; i <= 30; i++) expect(ids()).toContain(i);
    });

    it("weakens at most once a day and never below the recall-safe floor", () => {
        const rows: Array<[number, number, number, number]> = [];
        for (let i = 1; i <= 30; i++) rows.push([i, 5, 20, 1]);
        // Weak but importance 3: weakened, never pruned.
        rows.push([31, 3, 1, 120], [32, 3, 1, 120], [33, 3, 1, 120]);
        const { db, decay, setDecay } = makeDb(rows);
        setDecay(32, 0.3);
        setDecay(33, 0); // superseded row: must not be revived
        for (let pass = 0; pass < 4; pass++) synapticPrune(db as never); // a day of 6h passes
        expect(decay(31)).toBeCloseTo(0.8);
        expect(decay(32)).toBeCloseTo(0.25);
        expect(decay(33)).toBe(0);
    });
});
