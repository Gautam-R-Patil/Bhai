// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneCompileCache } from "../compile-cache.js";

describe("pruneCompileCache", () => {
    it("removes caches of other Node versions/arches, keeps this one's and anything else", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v8c-"));
        for (const d of [
            "v24.14.0-arm64-a703cd0d-501",
            "v24.19.0-arm64-bfb3c1cf-501",
            "v24.19.0-arm64-0000aaaa-501",
            "v24.19.0-x64-bfb3c1cf-501",
            "v26.12.1-arm64-310b2ce3-501",
        ]) {
            fs.mkdirSync(path.join(dir, d));
            fs.writeFileSync(path.join(dir, d, "entry"), "x");
        }
        fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
        const removed = await pruneCompileCache(dir, "24.19.0", "arm64");
        expect(removed.sort()).toEqual([
            "v24.14.0-arm64-a703cd0d-501",
            "v24.19.0-x64-bfb3c1cf-501",
            "v26.12.1-arm64-310b2ce3-501",
        ]);
        expect(fs.readdirSync(dir).sort()).toEqual([
            "notes.txt",
            "v24.19.0-arm64-0000aaaa-501",
            "v24.19.0-arm64-bfb3c1cf-501",
        ]);
        fs.rmSync(dir, { recursive: true });
    });

    it("is a no-op when the cache folder doesn't exist", async () => {
        expect(await pruneCompileCache(path.join(os.tmpdir(), "nope-v8c-x"), "24.19.0", "arm64")).toEqual([]);
    });
});
