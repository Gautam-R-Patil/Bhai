// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileMemo } from "../file-memo.js";

describe("fileMemo", () => {
    it("recomputes only when the file's size or mtime (or the extra key) changes", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-"));
        const file = path.join(dir, "log.jsonl");
        let runs = 0;
        const get = fileMemo(file, () => { runs++; return fs.existsSync(file) ? fs.readFileSync(file, "utf8").length : -1; });

        expect(get()).toBe(-1);   // missing file
        expect(get()).toBe(-1);
        expect(runs).toBe(1);

        fs.writeFileSync(file, "a\n");
        expect(get()).toBe(2);
        expect(get()).toBe(2);
        expect(runs).toBe(2);

        fs.appendFileSync(file, "b\n");
        expect(get()).toBe(4);
        expect(runs).toBe(3);

        fs.writeFileSync(file, "c\n");                    // same size, rewritten
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        expect(get()).toBe(2);
        expect(runs).toBe(4);

        expect(get("tomorrow")).toBe(2);                   // e.g. a new day
        expect(runs).toBe(5);

        fs.rmSync(file);
        expect(get("tomorrow")).toBe(-1);
        expect(runs).toBe(6);
        fs.rmSync(dir, { recursive: true });
    });
});
