// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushed: string[] = [];
let duringPush: (() => void) | undefined;
vi.mock("../session.js", () => ({ getSessionToken: async () => "t", handleAuthError: async () => null }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://example.test" }));
vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async (_url: string, init: { body: string }) => {
        pushed.push(JSON.parse(init.body).content);
        duringPush?.();
        return { ok: true, status: 200, json: async () => ({ success: true, version: pushed.length }) };
    },
}));

const { syncPersonalityIfPresent, watchPersonalityFile, loadActivePreset, getToneReminder } = await import("./personality-sync.js");

describe("personality-sync", () => {
    let dir: string;
    const file = () => path.join(dir, ".user-personality.json");
    const write = (preset: string) => fs.writeFileSync(file(), JSON.stringify({ preset, notes: "", updatedAt: Date.now() }));
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
        pushed.length = 0;
        duringPush = undefined;
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

    it("restates a non-default tone next to the message, not the default", async () => {
        write("unhinged");
        loadActivePreset({ userDataDir: dir });
        expect(getToneReminder()).toMatch(/UNHINGED/);
        await syncPersonalityIfPresent({ userDataDir: dir }); // file → synced marker
        write("casual_playful");
        await syncPersonalityIfPresent({ userDataDir: dir });
        expect(getToneReminder()).toBeNull();
    });

    it("syncs as soon as Settings writes the file", async () => {
        const stop = watchPersonalityFile({ userDataDir: dir });
        write("professional_concise");
        await vi.waitFor(() => expect(pushed.length).toBe(1), { timeout: 10000 });
        stop();
    });
});
