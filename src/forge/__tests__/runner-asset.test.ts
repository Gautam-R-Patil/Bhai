import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_FILENAME, writeRunnerAsset } from "../runner-asset.js";

describe("runner asset write", () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-runner-"));
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes the runner script to the target directory", async () => {
        await writeRunnerAsset(tmpDir);
        const path = join(tmpDir, RUNNER_FILENAME);
        expect(existsSync(path)).toBe(true);
        const content = readFileSync(path, "utf-8");
        expect(content).toContain("parentPort");
        expect(content).toContain("Module._resolveFilename");
        expect(content).toContain("ForgeCapabilityDenied");
    });

    it("overwrites an existing runner script", async () => {
        const path = join(tmpDir, RUNNER_FILENAME);
        writeFileSync(path, "// tampered");
        await writeRunnerAsset(tmpDir);
        const content = readFileSync(path, "utf-8");
        expect(content).not.toBe("// tampered");
        expect(content).toContain("parentPort");
    });

    it("creates the directory if missing", async () => {
        const nested = join(tmpDir, "new", "nested", "dir");
        await writeRunnerAsset(nested);
        expect(existsSync(join(nested, RUNNER_FILENAME))).toBe(true);
    });

    it("RUNNER_FILENAME is the stable contract name", () => {
        expect(RUNNER_FILENAME).toBe("_runner.js");
    });
});
