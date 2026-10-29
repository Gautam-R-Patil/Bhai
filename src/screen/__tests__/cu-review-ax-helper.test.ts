// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Regressions from the computer-use review: AX helper results (macOS paths, helper mocked).
import { describe, expect, it, vi } from "vitest";

type Reply = { stdout: string; fail?: boolean; code?: string };
let reply: Reply = { stdout: "" };
vi.mock("node:child_process", () => ({
    execFile: (_c: string, _a: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) => {
        if (!reply.fail) return cb(null, { stdout: reply.stdout, stderr: "" });
        cb(Object.assign(new Error("Command failed"), { stdout: reply.stdout, code: reply.code }));
    },
}));

const { axPerformAction, dumpAccessibilityTree, clearAxFailureCache } = await import("../ax-dump.js");
const el = { path: [0, 1], role: "AXButton", bbox: { x: 0, y: 0, w: 10, h: 10 } };

describe.runIf(process.platform === "darwin")("AX helper", () => {
    it("marks a press that may have run as unconfirmed, a refused one as not", async () => {
        reply = { stdout: "error|failed:-25204\n", fail: true };
        expect(await axPerformAction(1, el, "press")).toMatchObject({ ok: false, unconfirmed: true });
        reply = { stdout: "", fail: true }; // killed at the timeout
        expect(await axPerformAction(1, el, "press")).toMatchObject({ ok: false, unconfirmed: true });
        for (const e of ["element_changed", "element_gone", "unsupported:AXPress"]) {
            reply = { stdout: `error|${e}\n`, fail: true };
            expect(await axPerformAction(1, el, "press")).toMatchObject({ ok: false, unconfirmed: false });
        }
    });

    it("a missing grant is re-checked within seconds, not cached for minutes", async () => {
        clearAxFailureCache();
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            reply = { stdout: "error|not_trusted\n", fail: true };
            expect((await dumpAccessibilityTree()).error).toMatch(/permission missing/);
            reply = { stdout: JSON.stringify({ app: "Finder", pid: 3, trusted: true, depth: 20, root: { role: "AXApplication", label: null, value: null, x: 0, y: 0, w: 0, h: 0, focusable: false, enabled: true, children: [] } }) };
            vi.setSystemTime(Date.now() + 15_000); // the user granted it meanwhile
            expect((await dumpAccessibilityTree()).error).toBeUndefined();
        } finally {
            vi.useRealTimers();
            clearAxFailureCache();
        }
    });
});
