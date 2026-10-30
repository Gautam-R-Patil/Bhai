// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Phase 4 end-to-end smoke test.
//
// Validates the full happy-path flow:
//   1. synthesizeTool({persistent: true}) writes a manifest + returns awaiting_approval
//   2. approveDynamicTool registers the closure handler + flips lifecycle to active
//   3. invokePersistedTool round-trips a request → response under the sandbox
//   4. revokeDynamicTool drops the worker + archives the row

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNativeAvailable } from "../sandbox-supervisor.js";

const NATIVE = isNativeAvailable();

describe.skipIf(!NATIVE)("Phase 4 end-to-end smoke", () => {
    let tmpHome: string;
    const ORIG_ATLAS_HOME = process.env.ATLAS_HOME;

    beforeEach(() => {
        tmpHome = mkdtempSync(join(tmpdir(), "atlas-phase4-smoke-"));
        process.env.ATLAS_HOME = tmpHome;
    });

    afterEach(() => {
        if (ORIG_ATLAS_HOME === undefined) delete process.env.ATLAS_HOME;
        else process.env.ATLAS_HOME = ORIG_ATLAS_HOME;
        rmSync(tmpHome, { recursive: true, force: true });
    });

    it("install → invoke → uninstall lifecycle works end-to-end", async () => {
        const { installPersistedTool, invokePersistedTool, uninstallPersistedTool } = await import(
            "../sandbox-supervisor.js"
        );
        const { readManifest } = await import("../manifest.js");
        const slug = "phase4_doubler";
        // Same (input, utils, console) contract as session tools.
        const handlerCode = "return { doubled: input.x * 2, sep: utils.path.sep, req: typeof require('os').homedir };";
        // Any well-formed value: installPersistedTool pins the hash of the bytes it writes.
        const handlerHash = "0000000000000000";
        await installPersistedTool(
            slug,
            handlerCode,
            {
                slug,
                description: "Doubles input.x",
                capabilities: { fs_read: [], fs_write: [], net: [], exec: [] },
                parametersSchema: { type: "object", properties: { x: { type: "number" } } },
                version: "0.1.0",
                approvedAt: Date.now(),
                userQuote: "yes please install the doubler for phase 4 smoke",
                handlerHash,
            },
        );

        expect(readManifest(slug)?.handlerHash).not.toBe(handlerHash);
        const result = await invokePersistedTool(slug, { x: 21 });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.result).toEqual({ doubled: 42, sep: join("a", "b")[1], req: "function" });
        }

        await uninstallPersistedTool(slug);
    }, 30_000);
});
