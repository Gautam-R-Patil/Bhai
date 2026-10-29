// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "Actually, keep it short" must win over an earlier preference in the same
// session, and a capped update must not be reported as a success.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { getTrait, initTraitsDB, reinforceTrait, resetSessionTraitCaps } from "./traits.js";

type Row = Record<string, unknown>;
let DatabaseSync: (new (p: string) => { exec(s: string): void; prepare(s: string): { all(...a: unknown[]): Row[]; run(...a: unknown[]): unknown } }) | undefined;
try {
    DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
    /* older Node */
}

describe.skipIf(!DatabaseSync)("trait corrections", () => {
    it("an explicit correction replaces the value in the same session; inferred updates stay capped", () => {
        const raw = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
        const db = {
            exec: (sql: string, params: unknown[] = []) => {
                const r = raw.prepare(sql).all(...params);
                return r.length ? [{ columns: Object.keys(r[0]), values: r.map((x) => Object.values(x)) }] : [];
            },
            run: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...params),
        };
        initTraitsDB(db as never);
        resetSessionTraitCaps("s1");

        reinforceTrait("response_length", "detailed", { explicit: true });
        const corrected = reinforceTrait("response_length", "short", { explicit: true });
        expect(corrected?.value).toBe("short");
        expect(getTrait("response_length")?.confidence).toBeGreaterThanOrEqual(0.65);

        // An inferred (non-explicit) change to the same trait this session is skipped — and says so.
        expect(reinforceTrait("response_length", "detailed", { explicit: false })).toBeNull();
        expect(getTrait("response_length")?.value).toBe("short");
    });

    it("reinforcing a trait lowers its opposite's confidence but keeps the opposite's own value", () => {
        const raw = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
        const db = {
            exec: (sql: string, params: unknown[] = []) => {
                const r = raw.prepare(sql).all(...params);
                return r.length ? [{ columns: Object.keys(r[0]), values: r.map((x) => Object.values(x)) }] : [];
            },
            run: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...params),
        };
        initTraitsDB(db as never);
        resetSessionTraitCaps("s2");
        for (let i = 0; i < 4; i++) {
            resetSessionTraitCaps(`d${i}`); // one reinforcement per session
            reinforceTrait("likes_detailed_answers", "walk me through the reasoning", { explicit: true });
        }
        const before = getTrait("likes_detailed_answers")?.confidence ?? 0;
        expect(before).toBeGreaterThanOrEqual(0.7); // high enough to count as a conflict
        resetSessionTraitCaps("s3");
        reinforceTrait("likes_short_answers", "short replies", { explicit: true });
        const opposite = getTrait("likes_detailed_answers");
        expect(opposite?.value).toBe("walk me through the reasoning");
        expect(opposite?.confidence).toBeLessThan(before);
    });
});
