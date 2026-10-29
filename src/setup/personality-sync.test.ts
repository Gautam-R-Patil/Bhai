// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushed: string[] = [];
let duringPush: (() => void) | undefined;
let failPushes = 0;
vi.mock("../session.js", () => ({ getSessionToken: async () => "t", handleAuthError: async () => null }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://example.test" }));
vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async (_url: string, init: { body: string }) => {
        if (failPushes > 0) {
            failPushes--;
            return { ok: false, status: 400, json: async () => ({ success: false, error: "rate limit exceeded" }) };
        }
        pushed.push(JSON.parse(init.body).content);
        duringPush?.();
        return { ok: true, status: 200, json: async () => ({ success: true, version: pushed.length }) };
    },
}));

const { syncPersonalityIfPresent, watchPersonalityFile, loadActivePreset, getToneReminder, RETRY_MS } = await import("./personality-sync.js");

describe("personality-sync", () => {
    let dir: string;
    const file = () => path.join(dir, ".user-personality.json");
    const write = (preset: string) => fs.writeFileSync(file(), JSON.stringify({ preset, notes: "", updatedAt: Date.now() }));
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
        pushed.length = 0;
        duringPush = undefined;
        failPushes = 0;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("pushes the preset and marks the file synced", async () => {
        write("direct_terse");
        const r = await syncPersonalityIfPresent({ userDataDir: dir });
        expect(r.ran).toBe(true);
        expect(pushed[0]).toMatch(/direct/i);
        expect(fs.existsSync(file())).toBe(false);
        expect(fs.existsSync(path.join(dir, ".user-personality.synced.json"))).toBe(true);
    });

    it("keeps a newer save made during the push for the next sync", async () => {
        write("warm_supportive");
        duringPush = () => write("professional_concise");
        await syncPersonalityIfPresent({ userDataDir: dir });
        expect(fs.existsSync(file())).toBe(true);
    });

    it("restates the tone next to the message, and says unhinged is off after switching back", async () => {
        write("unhinged");
        loadActivePreset({ userDataDir: dir });
        expect(getToneReminder()).toMatch(/UNHINGED/);
        await syncPersonalityIfPresent({ userDataDir: dir }); // file → synced marker
        write("casual_playful");
        await syncPersonalityIfPresent({ userDataDir: dir });
        expect(getToneReminder()).toMatch(/CASUAL.*unhinged, is OFF/);
    });

    it("switching back still applies locally when the server refuses, and the push is retried", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            write("unhinged");
            await syncPersonalityIfPresent({ userDataDir: dir });
            failPushes = 1;
            write("casual_playful");
            const stop = watchPersonalityFile({ userDataDir: dir }); // file present → boot sync failed path
            await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
            expect(getToneReminder()).toMatch(/CASUAL/); // local tone follows the choice even though the push failed
            expect(fs.existsSync(file())).toBe(true); // still unsynced
            await vi.advanceTimersByTimeAsync(RETRY_MS[0]); // second attempt succeeds
            // The default is a short "unchanged" dial, not identity restated as an override; the precedence clause stays.
            expect(pushed.at(-1)).toMatch(/Dial: default/);
            expect(pushed.at(-1)).toMatch(/still take precedence/);
            expect(pushed.at(-1)).not.toMatch(/across channels/);
            expect(fs.existsSync(file())).toBe(false);
            stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("syncs as soon as Settings writes the file", async () => {
        const stop = watchPersonalityFile({ userDataDir: dir });
        // macOS FSEvents drops writes made in the first few ms after fs.watch() (a third of runs
        // here); in the app the watcher starts at boot, long before Settings writes.
        await new Promise((r) => setTimeout(r, 200));
        write("professional_concise");
        await vi.waitFor(() => expect(pushed.length).toBe(1), { timeout: 10000 });
        stop();
    });
});
