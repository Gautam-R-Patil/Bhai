// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageConfigPath } from "./installer.js";

describe("packageConfigPath", () => {
    it("prefers bhai.config.json", () => {
        const dir = mkdtempSync(join(tmpdir(), "bhai-pkg-"));
        writeFileSync(join(dir, "bhai.config.json"), "{}");
        writeFileSync(join(dir, "atlas.config.json"), "{}");
        expect(packageConfigPath(dir)).toBe(join(dir, "bhai.config.json"));
    });

    it("accepts an old package's atlas.config.json", () => {
        const dir = mkdtempSync(join(tmpdir(), "bhai-pkg-"));
        writeFileSync(join(dir, "atlas.config.json"), "{}");
        expect(packageConfigPath(dir)).toBe(join(dir, "atlas.config.json"));
    });

    it("names bhai.config.json when neither exists", () => {
        const dir = mkdtempSync(join(tmpdir(), "bhai-pkg-"));
        expect(packageConfigPath(dir)).toBe(join(dir, "bhai.config.json"));
    });
});
