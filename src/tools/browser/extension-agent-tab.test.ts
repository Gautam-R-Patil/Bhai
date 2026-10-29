// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The extension keeps acting on Bhai's tab when the owner clicks another one mid-task.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../../chrome-extension/background.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("// ── Bhai's tab ──"), src.indexOf("// (agent-tab:end)"));

function load(tabs: Array<{ id: number; active: boolean; focused?: boolean }>, clock: { now: number }) {
    const chrome = {
        tabs: {
            get: async (id: number) => {
                const t = tabs.find((x) => x.id === id);
                if (!t) throw new Error("No tab");
                return t;
            },
            query: async () => tabs.filter((t) => t.active && t.focused),
        },
    };
    const Date = { now: () => clock.now };
    return new Function("chrome", "Date", `${block}; return { agentTab, pinAgentTab };`)(chrome, Date) as {
        agentTab: () => Promise<{ id: number } | undefined>;
        pinAgentTab: (id: number | null) => void;
    };
}

describe("extension: Bhai's tab", () => {
    it("stays on Bhai's tab when the owner switches tabs mid-task", async () => {
        const tabs = [
            { id: 1, active: true, focused: true }, // where the task started
            { id: 2, active: false, focused: true },
        ];
        const clock = { now: 0 };
        const { agentTab } = load(tabs, clock);
        expect((await agentTab())?.id).toBe(1);
        // the owner clicks tab 2
        tabs[0].active = false;
        tabs[1].active = true;
        clock.now += 30_000;
        expect((await agentTab())?.id).toBe(1);
    });

    it("a new task after 2 min idle starts on the tab in front; a closed tab is let go", async () => {
        const tabs = [
            { id: 1, active: false, focused: true },
            { id: 2, active: true, focused: true },
        ];
        const clock = { now: 0 };
        const { agentTab, pinAgentTab } = load(tabs, clock);
        pinAgentTab(1);
        clock.now += 121_000;
        expect((await agentTab())?.id).toBe(2);
        pinAgentTab(99); // Bhai's tab was closed
        expect((await agentTab())?.id).toBe(2);
    });
});
