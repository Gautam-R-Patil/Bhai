// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The step deadline bounds the skill's code, not starting Node. A fake fork
// boots slower than the deadline: the step must still run. (A real cold fork
// takes ~35ms on a fast Mac and seconds on a loaded Windows runner, where the
// first step of a task used to die as skill_timeout.)
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type Child = EventEmitter & {
    exitCode: number | null;
    signalCode: string | null;
    send: (m: unknown) => void;
    kill: () => void;
};
const plan = { bootMs: 0, ready: true, stepMs: 0 };

vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    fork: () => {
        const c = new EventEmitter() as Child;
        c.exitCode = null;
        c.signalCode = null;
        c.kill = () => {
            c.signalCode = "SIGKILL";
        };
        const readyAt = Date.now() + plan.bootMs;
        c.send = (m) => {
            const { id } = m as { id: number };
            const wait = Math.max(0, readyAt - Date.now()) + plan.stepMs; // a message waits for boot
            setTimeout(() => c.emit("message", { id, ok: true, result: { actions: [] } }), wait);
        };
        if (plan.ready) setTimeout(() => c.emit("message", { ready: true }), plan.bootMs);
        return c;
    },
}));

const { SkillHost } = await import("../host.js");

afterEach(() => {
    delete process.env.BHAI_SITE_SKILL_DEADLINE_MS;
    delete process.env.BHAI_SITE_SKILL_BOOT_MS;
});

describe("SkillHost boot vs step deadline", () => {
    it("a slow process start doesn't count against the step deadline", async () => {
        process.env.BHAI_SITE_SKILL_DEADLINE_MS = "50";
        Object.assign(plan, { bootMs: 150, ready: true, stepMs: 5 });
        const h = new SkillHost("/x/skill.cjs");
        expect(await h.call("search", {})).toEqual({ actions: [] }); // cold
        expect(await h.call("search", {})).toEqual({ actions: [] }); // warm: no boot wait
        h.close();
    });

    it("a step slower than the deadline still times out once the child is up", async () => {
        process.env.BHAI_SITE_SKILL_DEADLINE_MS = "50";
        Object.assign(plan, { bootMs: 10, ready: true, stepMs: 200 });
        const h = new SkillHost("/x/skill.cjs");
        expect(await h.call("search", {})).toEqual({ fail: { reason: "skill_timeout" } });
    });

    it("a child that never comes up fails as skill_boot_timeout, not as the skill's fault", async () => {
        process.env.BHAI_SITE_SKILL_BOOT_MS = "60";
        Object.assign(plan, { bootMs: 0, ready: false, stepMs: 10_000 });
        const h = new SkillHost("/x/skill.cjs");
        expect(await h.call("search", {})).toEqual({ fail: { reason: "skill_boot_timeout" } });
    });
});
