// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    execFile: vi.fn(() => {
        throw new Error("no install expected");
    }),
}));

describe("python sidecar venv", () => {
    it("a venv marked ready before the rename (.atlas-ready) is reused, not reinstalled", async () => {
        const { getDataDir } = await import("../../config/paths.js");
        const venv = path.join(getDataDir(), "video-studio", "venv");
        mkdirSync(venv, { recursive: true });
        writeFileSync(path.join(venv, ".atlas-ready"), "x");
        const { ensurePythonEnv } = await import("./python-sidecar.js");
        await expect(ensurePythonEnv()).resolves.toBeUndefined();
    });
});
