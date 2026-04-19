// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { runPhases, getResumeList, readSetupState, writeSetupState, redactSecrets } from "../../installer/runner.js";

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-runner-")); });

function ctx() { return { DATA_DIR: tmp, sendProgress: () => {}, sendLog: () => {} }; }

describe("redactSecrets", () => {
    it("masks TELEGRAM_BOT_TOKEN= value", () => {
        expect(redactSecrets("Token: TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"))
            .toMatch(/TELEGRAM_BOT_TOKEN=\*\*\*/);
    });
    it("masks DISCORD_BOT_TOKEN= value", () => {
        expect(redactSecrets("DISCORD_BOT_TOKEN=a".repeat(60))).toMatch(/\*\*\*/);
    });
    it("masks EMAIL_PASSWORD= value", () => {
        expect(redactSecrets("EMAIL_PASSWORD=hunter2supersecret")).toMatch(/EMAIL_PASSWORD=\*\*\*/);
    });
    it("masks standalone bot-token pattern (no KEY= prefix)", () => {
        const line = "Calling 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij with api.telegram.org";
        expect(redactSecrets(line)).toMatch(/\*\*\*/);
        expect(redactSecrets(line)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    });
    it("masks Bot <token> header form", () => {
        expect(redactSecrets("Authorization: Bot MTA1MjM0NTY3ODkwMTIzNDU2Nzg5MA.something")).toMatch(/Bot\s+\*\*\*/);
    });
    it("leaves non-secret text alone", () => {
        expect(redactSecrets("Playwright installed OK")).toBe("Playwright installed OK");
    });
    it("coerces null/undefined to empty string", () => {
        expect(redactSecrets(null)).toBe("");
        expect(redactSecrets(undefined)).toBe("");
    });
});

describe("read/writeSetupState", () => {
    it("reads {} when file missing", () => {
        expect(readSetupState(tmp)).toEqual({});
    });
    it("round-trips a state object", () => {
        writeSetupState(tmp, { foo: { completedAt: "t1" } });
        expect(readSetupState(tmp)).toEqual({ foo: { completedAt: "t1" } });
    });
    it("recovers from corrupt JSON (returns {})", () => {
        fs.writeFileSync(path.join(tmp, "setup-state.json"), "{ not json");
        expect(readSetupState(tmp)).toEqual({});
    });
});

describe("getResumeList", () => {
    it("filters already-completed phases", () => {
        const full = [{ id: "a" }, { id: "b" }, { id: "c" }];
        const state = { a: { completedAt: "t1", durationMs: 1 } };
        expect(getResumeList(full, state).map((p) => p.id)).toEqual(["b", "c"]);
    });
    it("returns [] when everything is completed", () => {
        const full = [{ id: "a" }, { id: "b" }];
        const state = { a: { completedAt: "x" }, b: { completedAt: "y" } };
        expect(getResumeList(full, state)).toEqual([]);
    });
    it("ignores __-prefixed metadata keys", () => {
        const full = [{ id: "a" }, { id: "b" }];
        const state = { __version: 2, __finalizedAt: "t", a: { completedAt: "x" } };
        expect(getResumeList(full, state).map((p) => p.id)).toEqual(["b"]);
    });
    it("nullish state treats all phases as pending", () => {
        const full = [{ id: "a" }, { id: "b" }];
        expect(getResumeList(full, null).map((p) => p.id)).toEqual(["a", "b"]);
        expect(getResumeList(full, undefined).map((p) => p.id)).toEqual(["a", "b"]);
    });
});

describe("runPhases — happy path", () => {
    it("runs all phases sequentially and writes per-phase markers", async () => {
        const order = [];
        const res = await runPhases([
            { id: "a", label: "A", run: async () => { order.push("a"); } },
            { id: "b", label: "B", run: async () => { order.push("b"); } },
        ], ctx());
        expect(res.status).toBe("complete");
        expect(order).toEqual(["a", "b"]);
        const s = readSetupState(tmp);
        expect(s.a.completedAt).toBeDefined();
        expect(s.b.completedAt).toBeDefined();
    });
    it("emits per-phase progress + final 100", async () => {
        const progress = [];
        const res = await runPhases([
            { id: "a", label: "A", run: async () => {} },
            { id: "b", label: "B", run: async () => {} },
        ], { DATA_DIR: tmp, sendProgress: (p, m) => progress.push({ p, m }), sendLog: () => {} });
        expect(res.status).toBe("complete");
        expect(progress[0].p).toBe(0);
        expect(progress[progress.length - 1].p).toBe(100);
    });
    it("log lines are redacted before hitting sendLog", async () => {
        const logged = [];
        await runPhases([
            { id: "a", label: "A", run: async (_ctx, log) => { log("TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"); } },
        ], { DATA_DIR: tmp, sendProgress: () => {}, sendLog: (m) => logged.push(m) });
        expect(logged.some((l) => /TELEGRAM_BOT_TOKEN=\*\*\*/.test(l))).toBe(true);
        expect(logged.every((l) => !/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij/.test(l))).toBe(true);
    });
});

describe("runPhases — pause on error", () => {
    it("pauses on thrown error; later phases not run", async () => {
        const order = [];
        const res = await runPhases([
            { id: "a", label: "A", run: async () => { order.push("a"); } },
            { id: "b", label: "B", run: async () => { order.push("b"); throw new Error("boom"); } },
            { id: "c", label: "C", run: async () => { order.push("c"); } },
        ], ctx());
        expect(res.status).toBe("paused");
        expect(res.failedPhase).toEqual({ id: "b", label: "B" });
        expect(res.error.message).toBe("boom");
        expect(order).toEqual(["a", "b"]); // c not run
        const s = readSetupState(tmp);
        expect(s.a).toBeDefined();
        expect(s.b).toBeUndefined();
        expect(s.c).toBeUndefined();
    });
    it("emits a paused sendProgress(-1)", async () => {
        const progress = [];
        await runPhases([
            { id: "a", label: "A", run: async () => { throw new Error("x"); } },
        ], { DATA_DIR: tmp, sendProgress: (p, m) => progress.push({ p, m }), sendLog: () => {} });
        expect(progress.some((e) => e.p === -1)).toBe(true);
    });
});

describe("runPhases — resume", () => {
    it("resume skips already-completed phases", async () => {
        writeSetupState(tmp, { a: { completedAt: "earlier", durationMs: 1 } });
        const fullList = [
            { id: "a", label: "A", run: async () => { throw new Error("should not rerun a"); } },
            { id: "b", label: "B", run: async () => {} },
        ];
        const resumeList = getResumeList(fullList, readSetupState(tmp));
        const res = await runPhases(resumeList, ctx());
        expect(res.status).toBe("complete");
        expect(readSetupState(tmp).b).toBeDefined();
    });
});
