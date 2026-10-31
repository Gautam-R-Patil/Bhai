// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// native/index.js falls back to a pre-rename atlas-native.<triple>.node when
// bhai-native.<triple>.node is missing (a dev machine with a stale build).
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const nativeDir = join(process.cwd(), "native");
const triple = `${process.platform}-${process.arch}`;
const built = join(nativeDir, `bhai-native.${triple}.node`);

describe.skipIf(!existsSync(built))("native/index.js legacy binary fallback", () => {
    it("loads atlas-native.<triple>.node when the new binary is missing", () => {
        const dir = mkdtempSync(join(tmpdir(), "bhai-native-"));
        copyFileSync(join(nativeDir, "index.js"), join(dir, "index.js"));
        writeFileSync(join(dir, "binding.js"), 'throw new Error("no bhai-native binary");\n');
        copyFileSync(built, join(dir, `atlas-native.${triple}.node`));
        const mod = createRequire(import.meta.url)(join(dir, "index.js"));
        expect(Object.keys(mod).length).toBeGreaterThan(0);
    });

    it("stays empty (fail-open) when neither binary exists", () => {
        const dir = mkdtempSync(join(tmpdir(), "bhai-native-"));
        copyFileSync(join(nativeDir, "index.js"), join(dir, "index.js"));
        writeFileSync(join(dir, "binding.js"), 'throw new Error("no bhai-native binary");\n');
        const strict = process.env.BHAI_REQUIRE_NATIVE;
        delete process.env.BHAI_REQUIRE_NATIVE;
        try {
            expect(createRequire(import.meta.url)(join(dir, "index.js"))).toEqual({});
        } finally {
            if (strict !== undefined) process.env.BHAI_REQUIRE_NATIVE = strict;
        }
    });
});
