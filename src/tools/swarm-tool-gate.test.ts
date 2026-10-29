// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// executeTool's swarm gate: inside a swarm run an external side effect never
// reaches its handler without the owner's consent for the run or the step;
// with it, the per-call consent prompt is skipped (sub-agents can't ask).
// Outside a swarm, executeTool behaves as before.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const spyTool = (name: string) => ({
    schema: { type: "function", function: { name, parameters: { type: "object", properties: {} } } },
    handler: async () => {
        calls.push(name);
        return JSON.stringify({ ok: true });
    },
});
vi.mock("../whatsapp.js", async (orig) => ({ ...(await orig<object>()), whatsappSendTool: spyTool("whatsapp_send") }));
vi.mock("./files.js", async (orig) => ({ ...(await orig<object>()), deleteFile: spyTool("delete_file") }));

const { executeTool } = await import("./index.js");
const { withSwarmRun, withSwarmStep, swarmConsentKey, currentSwarmRun, currentSwarmStep } = await import(
    "../agents/swarm-context.js"
);
const { getRegistryRef } = await import("./create-tool.js");
const { _resetConsent } = await import("../security/consent.js");
const { _resetSendLedger } = await import("./send-ledger.js");
type Run = import("../agents/swarm-context.js").SwarmRunContext;
const newRun = (over: Partial<Run> = {}): Run => ({
    consentKey: swarmConsentKey("t"),
    consentGranted: false,
    blocked: [],
    approvedSteps: new Set(),
    ...over,
});
const inStep = <T>(run: Run, approved: boolean, fn: () => Promise<T>) =>
    withSwarmRun(run, () => withSwarmStep({ stepId: "s1", stepApproved: approved }, fn));

beforeEach(() => {
    calls.length = 0;
    _resetConsent();
    _resetSendLedger();
});

describe("executeTool swarm gate", () => {
    it("holds back a send inside a swarm without consent and records it", async () => {
        const run = newRun();
        const out = await inStep(run, false, () => executeTool("whatsapp_send", { to: "Rahul", message: "hi" }));
        expect(JSON.parse(out).needs_owner_approval).toBe(true);
        expect(calls).toEqual([]);
        expect(run.blocked).toEqual([{ step: "s1", tool: "whatsapp_send", summary: "whatsapp_send → Rahul" }]);
    });

    it("a model-set confirmed flag does not get past it", async () => {
        const out = await inStep(newRun(), false, () => executeTool("delete_file", { path: "/tmp/x", confirmed: true }));
        expect(JSON.parse(out).needs_owner_approval).toBe(true);
        expect(calls).toEqual([]);
    });

    it("runs it in an approved step without a second consent prompt", async () => {
        await inStep(newRun(), true, () => executeTool("delete_file", { path: "/tmp/x" }));
        await inStep(newRun(), true, () => executeTool("whatsapp_send", { to: "Rahul", message: "hi" }));
        expect(calls).toEqual(["delete_file", "whatsapp_send"]);
    });

    it("a granted re-run still holds a step the owner was not told about", async () => {
        const run = newRun({ consentGranted: true, approvedSteps: new Set(["s9"]) });
        const out = await inStep(run, false, () => executeTool("delete_file", { path: "~/Documents" }));
        expect(JSON.parse(out).needs_owner_approval).toBe(true);
        expect(calls).toEqual([]);
    });

    it("gates a tool registered after boot (Forge, store) even under a harmless name", async () => {
        const reg = getRegistryRef();
        reg?.set("weather_now", spyTool("weather_now") as never);
        try {
            const out = await inStep(newRun(), false, () => executeTool("weather_now", {}));
            expect(JSON.parse(out).needs_owner_approval).toBe(true);
            expect(calls).toEqual([]);
        } finally {
            reg?.delete("weather_now");
        }
    });

    it("leaves reads alone inside a swarm", async () => {
        const run = newRun();
        const out = await inStep(run, false, () => executeTool("get_current_time", {}));
        expect(out).not.toMatch(/needs_owner_approval/);
        expect(run.blocked).toEqual([]);
    });

    it("leaves coding/research shell and generic browser/desktop input to run; holds shell launchers", async () => {
        const swarmGateOnly = async (name: string, args: Record<string, unknown>) => {
            const { swarmGate } = await import("../agents/swarm-context.js");
            const run = newRun();
            const res = await inStep(run, false, () => swarmGate(name, args));
            return res === null ? "runs" : JSON.parse(res).needs_owner_approval ? "held" : res;
        };
        for (const [name, args] of [
            ["shell_exec", { command: "cat firebase.json" }],
            ["shell_exec", { command: "npm install firebase" }],
            ["shell_exec", { command: "gh pr view 12" }],
            ["shell_exec", { command: "grep -rn eval src/" }],
            ["browser_click", { text: "Next page" }],
            ["browser_type", { text: "usb-c hub", label: 3 }],
            ["os_smart_click", { description: "Search button" }],
        ] as Array<[string, Record<string, unknown>]>) {
            expect(await swarmGateOnly(name, args), `${name} ${JSON.stringify(args)}`).toBe("runs");
        }
        for (const command of [
            "shortcuts run 'Pay Rent'",
            'open "shortcuts://run-shortcut?name=Pay"',
            "open -a Terminal x.command",
            `osascript -e 'tell application "Messages" to send "hi" to buddy "Rahul"'`,
        ]) {
            expect(await swarmGateOnly("shell_exec", { command }), command).toBe("held");
        }
        expect(await swarmGateOnly("whatsapp_send", { to: "Rahul" })).toBe("held");
    });

    it("a grep that mentions shutdown runs in a swarm without a hold or a consent prompt", async () => {
        const run = newRun();
        const out = await inStep(run, false, () => executeTool("shell_exec", { command: "grep -c shutdown /dev/null" }));
        expect(out).not.toMatch(/needs_owner_approval|needs_confirmation/);
        expect(run.blocked).toEqual([]);
    });

    it("background work an approved step starts doesn't inherit its grant (a long task's phases)", async () => {
        const reg = getRegistryRef();
        const original = reg?.get("start_long_task");
        let seen: unknown[] = [];
        let phase: Promise<string> = Promise.resolve("");
        reg?.set("start_long_task", {
            ...spyTool("start_long_task"),
            handler: async () => {
                seen = [currentSwarmRun(), currentSwarmStep()];
                // fire-and-forget, like startLongTask's executePhases
                phase = new Promise((r) => setTimeout(r, 1)).then(() =>
                    executeTool("delete_file", { path: "/tmp/x" }),
                );
                return JSON.stringify({ ok: true });
            },
        } as never);
        try {
            await inStep(newRun(), true, () => executeTool("start_long_task", { goal: "x" }));
            expect(seen).toEqual([undefined, undefined]);
            expect(JSON.parse(await phase).needs_confirmation).toBe(true);
            expect(calls).toEqual([]);
        } finally {
            if (original) reg?.set("start_long_task", original);
        }
    });

    it("outside a swarm a dangerous command split into command + args still asks", async () => {
        const r = JSON.parse(await executeTool("shell_exec", { command: "rm", args: ["-rf", "~/"] }));
        expect(r.needs_confirmation).toBe(true);
    });

    it("changes nothing outside a swarm: sends run, destructive calls still ask per call", async () => {
        await executeTool("whatsapp_send", { to: "Rahul", message: "hi" });
        expect(calls).toEqual(["whatsapp_send"]);
        const del = JSON.parse(await executeTool("delete_file", { path: "/tmp/x" }));
        expect(del.needs_confirmation).toBe(true);
        expect(calls).toEqual(["whatsapp_send"]);
    });
});
