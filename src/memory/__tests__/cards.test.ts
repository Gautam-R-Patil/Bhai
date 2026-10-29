// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../sqlite.js";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cards-"));

let sqlite: typeof import("../sqlite.js");
let cards: typeof import("../cards.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;

beforeAll(async () => {
    sqlite = await import("../sqlite.js");
    cards = await import("../cards.js");
    await sqlite.initMemoryDB();
    raw = sqlite.getRawDb() as typeof raw;
});

const row = (content: string, category = "fact", tags = "") =>
    Number(
        raw.prepare("INSERT INTO memories (content, category, tags) VALUES (?, ?, ?)").run(content, category, tags)
            .lastInsertRowid,
    );
const rec = (id: number): MemoryRecord =>
    raw.prepare("SELECT id, content, category, tags, importance, created_at, access_count FROM memories WHERE id = ?").get(
        id,
    ) as MemoryRecord;

describe("memory cards", () => {
    it("normalizes person:/project: tags and leaves the rest", () => {
        expect(cards.normalizeTags(" Person: Riya  Sharma ,work, PROJECT:Atlas")).toBe(
            "person:riya sharma,work,project:atlas",
        );
    });

    it("builds people/project/preference/commitment cards and keeps the rest as a plain list", () => {
        const riya = row("Riya is the owner's sister", "person", "person:riya");
        const riya2 = row("Riya moved to Pune", "fact", "family,person:riya");
        const mom = row("Mom prefers calls after 7pm", "preference", "person:mom");
        const atlas = row("Atlas launch is in December", "fact", "project:atlas");
        const arjun = row("Arjun plays the guitar", "person"); // untagged, matched by capitalized name
        const promise = row("Send Riya the wedding photos by Friday", "commitment", "person:riya");
        row("Kabir likes cricket", "fact", "person:kabir"); // not mentioned
        const old = row("Riya lived in Delhi", "fact", "person:riya");
        raw.prepare("UPDATE memories SET consolidated_into = ? WHERE id = ?").run(riya2, old); // superseded
        const pref = row("Owner likes short replies", "preference");
        const plain = row("Owner's wifi is slow at night");

        const out = cards.buildMemoryCards(
            "Can you ask Riya and Arjun about the atlas plan? Also ping mom",
            [rec(pref), rec(plain), rec(riya)],
            new Set([atlas]), // already in core memory
        );
        const lines = out.cards.split("\n");
        expect(lines.find((l) => l.startsWith("PEOPLE — Riya:"))).toMatch(
            new RegExp(`#${riya} · today.*#${riya2} · today|#${riya2} · today.*#${riya} · today`),
        );
        expect(out.cards).toContain(`PEOPLE — Mom: Mom prefers calls after 7pm (#${mom} · today)`);
        expect(out.cards).toContain(`PEOPLE — Arjun: Arjun plays the guitar (#${arjun}`);
        expect(out.cards).toContain(`PREFERENCES — Owner likes short replies (#${pref}`);
        expect(out.cards).toContain(`COMMITMENTS — Send Riya the wedding photos by Friday (#${promise}`);
        expect(out.cards).not.toMatch(/Kabir|Delhi|PROJECTS/); // unmentioned, superseded, skipped
        expect(out.rest.map((m) => m.id)).toEqual([plain]);
        expect(new Set(out.ids)).toEqual(new Set([riya, riya2, mom, arjun, pref, promise]));
    });

    it("no names, no cards: recalled rows stay in the plain list", () => {
        const plain = row("Owner's wifi password hint is the dog's name");
        const out = cards.buildMemoryCards("what's the weather like", [rec(plain)]);
        expect(out).toEqual({ cards: "", ids: [], rest: [rec(plain)] });
    });
});
