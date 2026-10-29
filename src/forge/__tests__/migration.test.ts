// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, countTools } from "../library.js";
import { migrateLegacyDynamicTools } from "../migration.js";
import { initForgeTelemetry } from "../telemetry.js";

describe("legacy migration", () => {
    let tmpDir: string;
    let legacyDir: string;
    let storeDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-mig-"));
        legacyDir = join(tmpDir, "dynamic-tools");
        storeDir = join(tmpDir, "store", "dynamic");
        mkdirSync(legacyDir, { recursive: true });
        mkdirSync(storeDir, { recursive: true });
        openLibrary(join(tmpDir, "lib.db"));
        initForgeTelemetry(join(tmpDir, "tele.jsonl"));
    });

    afterEach(() => {
        closeLibrary();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("migrates a single valid legacy file", async () => {
        writeFileSync(join(legacyDir, "extract_pdf.json"), JSON.stringify({
            name: "extract_pdf",
            description: "Extract PDF",
            parameters_schema: { type: "object", properties: {}, required: [] },
            handler_code: "return 'ok';",
            created_at: new Date().toISOString(),
        }));

        const result = await migrateLegacyDynamicTools({
            legacyDir, dynamicStoreDir: storeDir,
            embedFn: async (_text: string) => new Float32Array(384),
        });

        expect(result.migrated).toBe(1);
        expect(result.failed).toBe(0);
        expect(countTools().total).toBe(1);
        expect(existsSync(join(storeDir, "extract_pdf", "handler.js"))).toBe(true);
        expect(existsSync(join(storeDir, "extract_pdf", "schema.json"))).toBe(true);
    });

    it("skips malformed JSON, continues on others", async () => {
        writeFileSync(join(legacyDir, "bad.json"), "{ malformed");
        writeFileSync(join(legacyDir, "good.json"), JSON.stringify({
            name: "good", description: "ok",
            parameters_schema: {}, handler_code: "return 1;",
            created_at: new Date().toISOString(),
        }));

        const result = await migrateLegacyDynamicTools({
            legacyDir, dynamicStoreDir: storeDir,
            embedFn: async () => new Float32Array(384),
        });

        expect(result.migrated).toBe(1);
        expect(result.failed).toBe(1);
        expect(countTools().total).toBe(1);
    });

    it("is idempotent — running twice does not duplicate", async () => {
        writeFileSync(join(legacyDir, "x.json"), JSON.stringify({
            name: "x", description: "x",
            parameters_schema: {}, handler_code: "return 1;",
            created_at: new Date().toISOString(),
        }));

        await migrateLegacyDynamicTools({ legacyDir, dynamicStoreDir: storeDir, embedFn: async () => new Float32Array(384) });
        const result2 = await migrateLegacyDynamicTools({ legacyDir, dynamicStoreDir: storeDir, embedFn: async () => new Float32Array(384) });

        expect(countTools().total).toBe(1);
        expect(result2.alreadyMigrated).toBe(1);
    });

    it("skips when legacyDir does not exist", async () => {
        const result = await migrateLegacyDynamicTools({
            legacyDir: join(tmpDir, "doesnt-exist"),
            dynamicStoreDir: storeDir,
            embedFn: async () => new Float32Array(384),
        });
        expect(result.migrated).toBe(0);
        expect(result.failed).toBe(0);
    });

    it("missing required field is logged as failure", async () => {
        writeFileSync(join(legacyDir, "incomplete.json"), JSON.stringify({
            name: "incomplete",
            // missing description, handler_code
        }));
        const result = await migrateLegacyDynamicTools({
            legacyDir, dynamicStoreDir: storeDir,
            embedFn: async () => new Float32Array(384),
        });
        expect(result.failed).toBe(1);
    });

    it("rejects path-traversal slug names", async () => {
        writeFileSync(join(legacyDir, "evil.json"), JSON.stringify({
            name: "../../etc/cron",
            description: "evil",
            parameters_schema: {},
            handler_code: "return 1;",
        }));
        const result = await migrateLegacyDynamicTools({
            legacyDir, dynamicStoreDir: storeDir,
            embedFn: async () => new Float32Array(384),
        });
        expect(result.failed).toBe(1);
        expect(result.migrated).toBe(0);
        expect(existsSync(join(tmpDir, "etc"))).toBe(false);
    });
});
