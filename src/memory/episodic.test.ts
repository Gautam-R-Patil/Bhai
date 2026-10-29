// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-episodic-"));

let sqlite: typeof import("./sqlite.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;
let episodic: typeof import("./episodic.js");

beforeAll(async () => {
    sqlite = await import("./sqlite.js");
    episodic = await import("./episodic.js");
    episodic.initEpisodicMemory(await sqlite.initMemoryDB());
    raw = sqlite.getRawDb() as typeof raw;
});

describe("episodic memory", () => {
    it("lets fresh milestones outrank an old high-importance one", () => {
        episodic.recordEpisode("milestone", "Shipped v1 launch", 0.95);
        raw.prepare("UPDATE episodic_memory SET timestamp = datetime('now', '-60 days') WHERE description = ?").run(
            "Shipped v1 launch",
        );
        for (const d of ["Fixed billing", "Hired designer", "Moved to Pune"])
            episodic.recordEpisode("milestone", d, 0.6);
        episodic.recordEpisode("milestone", "Minor note", 0.2);

        const snippet = episodic.getEpisodicSnippet();
        expect(snippet).toContain("Fixed billing");
        expect(snippet).toContain("Hired designer");
        expect(snippet).toContain("Moved to Pune");
        expect(snippet).not.toContain("Shipped v1 launch");
        expect(snippet).toContain("today");
    });

    it("refreshes a re-recorded milestone instead of duplicating it", () => {
        episodic.recordEpisode("milestone", "shipped V1 LAUNCH", 0.5);
        const rows = raw
            .prepare(
                "SELECT importance_score, timestamp >= datetime('now', '-1 minute') AS fresh FROM episodic_memory WHERE lower(description) = 'shipped v1 launch'",
            )
            .all() as { importance_score: number; fresh: number }[];
        expect(rows).toEqual([{ importance_score: 0.95, fresh: 1 }]);
    });
});
