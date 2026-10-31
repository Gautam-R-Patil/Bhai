// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-normfact-"));

let sqlite: typeof import("../sqlite.js");

beforeAll(async () => {
    sqlite = await import("../sqlite.js");
    await sqlite.initMemoryDB();
});

describe("normFact", () => {
    it("keeps combining marks, so Devanagari words differing only by matras stay distinct", () => {
        expect(sqlite.normFact("मुझे दाल पसंद है")).not.toBe(sqlite.normFact("मुझे दिल पसंद है"));
        expect(sqlite.normFact("पापा।")).toBe("पापा");
    });

    it("stays case- and punctuation-insensitive for English", () => {
        expect(sqlite.normFact("  Owner LOVES chai!! ")).toBe("owner loves chai");
        expect(sqlite.normFact("owner, loves... chai")).toBe(sqlite.normFact("Owner loves chai."));
        expect(sqlite.normFact("Loves pizza ❤️")).toBe("loves pizza"); // U+FE0F is a mark, not part of a word
    });

    it("findExactMemory does not treat a matra-only variant as a duplicate", () => {
        const raw = sqlite.getRawDb() as NonNullable<ReturnType<typeof sqlite.getRawDb>>;
        const id = Number(
            raw.prepare("INSERT INTO memories (content, category) VALUES (?, 'fact')").run("मुझे दाल पसंद है").lastInsertRowid,
        );
        expect(sqlite.findExactMemory("मुझे दाल पसंद है।")).toBe(id);
        expect(sqlite.findExactMemory("मुझे दिल पसंद है")).toBeNull();
    });
});
