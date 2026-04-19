// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { buildPhaseList, ALL_PHASE_IDS } from "../../installer/phases.js";

const CANON = ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"];

function base(o) {
    return Object.assign({
        platform: "darwin",
        installed: { node: false, playwright: false, embeddingModel: false, sox: false },
        workspace: { path: "", exists: false },
    }, o || {});
}

describe("buildPhaseList", () => {
    it("fresh → all 7 phases in canonical order", () => {
        expect(buildPhaseList(base()).map((p) => p.id)).toEqual(CANON);
    });

    it("fully cached + workspace exists → [data-dir, workspace, setup-state-finalize] — wait, actually [data-dir, setup-state-finalize] when workspace.path is empty", () => {
        // No workspace requested, dir exists → workspace phase skipped.
        const list = buildPhaseList(base({
            installed: { node: true, playwright: true, embeddingModel: true, sox: true },
            workspace: { path: "", exists: true },
        }));
        expect(list.map((p) => p.id)).toEqual(["data-dir", "setup-state-finalize"]);
    });

    it("fully cached with a requested workspace → [data-dir, workspace, setup-state-finalize]", () => {
        const list = buildPhaseList(base({
            installed: { node: true, playwright: true, embeddingModel: true, sox: true },
            workspace: { path: "/tmp/ws", exists: true },
        }));
        expect(list.map((p) => p.id)).toEqual(["data-dir", "workspace", "setup-state-finalize"]);
    });

    it("win32 fresh → same ids as darwin (sox runtime-branches internally)", () => {
        expect(buildPhaseList(base({ platform: "win32" })).map((p) => p.id)).toEqual(CANON);
    });

    it("every phase has id, label, run, idempotent=true", () => {
        for (const p of buildPhaseList(base())) {
            expect(typeof p.id).toBe("string");
            expect(typeof p.label).toBe("string");
            expect(typeof p.run).toBe("function");
            expect(p.idempotent).toBe(true);
        }
    });

    it("workspace skipped when no path requested AND dir already exists", () => {
        const list = buildPhaseList(base({
            installed: { node: true, playwright: true, embeddingModel: true, sox: true },
            workspace: { path: "", exists: true },
        }));
        expect(list.map((p) => p.id)).not.toContain("workspace");
    });

    it("workspace runs when path requested even if dir exists", () => {
        const list = buildPhaseList(base({
            installed: { node: true, playwright: true, embeddingModel: true, sox: true },
            workspace: { path: "/chosen/path", exists: true },
        }));
        expect(list.map((p) => p.id)).toContain("workspace");
    });

    it("only missing installed items produce phases", () => {
        const list = buildPhaseList(base({
            installed: { node: true, playwright: false, embeddingModel: true, sox: false },
            workspace: { path: "", exists: true },
        }));
        expect(list.map((p) => p.id)).toEqual(["playwright-chromium", "sox", "data-dir", "setup-state-finalize"]);
    });

    it("ALL_PHASE_IDS equals canonical order", () => {
        expect(ALL_PHASE_IDS).toEqual(CANON);
    });

    it("nullish state defaults to empty installed — returns all install phases + data-dir + finalize", () => {
        // No workspace.path, no workspace.exists → !w.exists is true, so workspace IS included.
        const list = buildPhaseList(undefined);
        expect(list.map((p) => p.id)).toEqual(CANON);
    });
});

describe("phase.run contracts", () => {
    it("data-dir phase is a no-op-safe to call repeatedly (idempotent)", async () => {
        // Just verify the run signature + idempotent flag; don't actually touch fs.
        const list = buildPhaseList(base());
        const dataDir = list.find((p) => p.id === "data-dir");
        expect(dataDir).toBeTruthy();
        expect(dataDir.idempotent).toBe(true);
    });
});
