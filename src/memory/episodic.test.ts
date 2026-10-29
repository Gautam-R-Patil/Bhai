// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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

    it("retires an episode after three callbacks", () => {
        episodic.recordEpisode("achievement", "Closed seed round", 0.99);
        expect(episodic.getEpisodicSnippet()).toContain("Closed seed round");
        episodic.noteEpisodeCallbacks("Unrelated reply about the weather.");
        for (let i = 0; i < 3; i++) {
            expect(episodic.getEpisodicSnippet()).toContain("Closed seed round");
            episodic.noteEpisodeCallbacks("Like when you closed that seed round, nice.");
        }
        expect(episodic.getEpisodicSnippet()).not.toContain("Closed seed round");
    });

    it("doesn't count a reply that only shares short function words", () => {
        const description = "Decided to move from Delhi to Bangalore with family";
        episodic.recordEpisode("decision", description, 0.999);
        expect(episodic.getEpisodicSnippet()).toContain(description);
        episodic.noteEpisodeCallbacks("Done — I sent that file from your Downloads folder, along with the notes.");
        const row = raw.prepare("SELECT callback_count FROM episodic_memory WHERE description = ?").get(description);
        expect(row).toEqual({ callback_count: 0 });
    });

    it("counts only callbacks Bhai brings up, once per offer", () => {
        const description = "Struggling with the desktop build";
        episodic.recordEpisode("struggle", description, 0.9999);
        const row = raw.prepare("SELECT callback_count FROM episodic_memory WHERE description = ?");
        const count = () => (row.get(description) as { callback_count: number }).callback_count;
        expect(episodic.getEpisodicSnippet()).toContain(description);
        // The owner asked about the build: the reply answers it, it isn't a callback.
        episodic.noteEpisodeCallbacks("The desktop build passed.", "did the desktop build pass?");
        // A second reply without a fresh offer scores nothing.
        episodic.noteEpisodeCallbacks("Remember that desktop build fight? Long gone.");
        expect(count()).toBe(0);
        episodic.getEpisodicSnippet();
        episodic.noteEpisodeCallbacks("Remember that desktop build fight? Long gone.", "what's new?");
        expect(count()).toBe(1);
    });
});
