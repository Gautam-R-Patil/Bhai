// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// trash_manager "trash" ran no path guard: Bhai's data dir, its code and ~/.ssh went to the Trash.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn((...args: unknown[]) => (args.at(-1) as (e: null, r: object) => void)(null, { stdout: "" })));
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFile }));

const { trashManager } = await import("../file-utils.js");

describe("trash_manager trash", () => {
    const dir = mkdtempSync(join(homedir(), ".bhai-trash-"));
    const prev = process.env.BHAI_USER_DATA_DIR;
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
        if (prev === undefined) delete process.env.BHAI_USER_DATA_DIR;
        else process.env.BHAI_USER_DATA_DIR = prev;
    });

    it.skipIf(process.platform === "win32")("refuses Bhai's own data, trashes an ordinary file", async () => {
        const state = join(dir, "userData");
        mkdirSync(state);
        writeFileSync(join(state, "audit.jsonl"), "{}");
        process.env.BHAI_USER_DATA_DIR = state;
        for (const p of [state, join(state, "audit.jsonl")]) {
            const r = JSON.parse(await trashManager.handler({ action: "trash", path: p }));
            expect(r.error).toMatch(/Refused/);
        }
        expect(execFile).not.toHaveBeenCalled();

        writeFileSync(join(dir, "old.txt"), "x");
        const ok = JSON.parse(await trashManager.handler({ action: "trash", path: join(dir, "old.txt") }));
        expect(ok.success).toBe(true);
        expect(execFile).toHaveBeenCalledTimes(1);
    });
});
