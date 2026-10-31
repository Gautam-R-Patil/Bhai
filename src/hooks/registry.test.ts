// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getLoadedSources, loadHooks } from "./registry.js";

function project(dirs: string[]): string {
    const root = mkdtempSync(path.join(tmpdir(), "bhai-hooks-"));
    for (const d of dirs) {
        mkdirSync(path.join(root, d));
        writeFileSync(path.join(root, d, "hooks.json"), JSON.stringify({ Stop: [{ command: "true" }] }));
    }
    return root;
}

describe("loadHooks project-local config", () => {
    it("reads .bhai/hooks.json over .atlas/hooks.json", () => {
        const root = project([".bhai", ".atlas"]);
        loadHooks(root);
        expect(getLoadedSources()).toContain(path.join(root, ".bhai", "hooks.json"));
        expect(getLoadedSources()).not.toContain(path.join(root, ".atlas", "hooks.json"));
    });

    it("still reads the old .atlas/hooks.json when there is no .bhai one", () => {
        const root = project([".atlas"]);
        loadHooks(root);
        expect(getLoadedSources()).toContain(path.join(root, ".atlas", "hooks.json"));
    });
});
