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

describe("extension: Bhai's own new tabs", () => {
    function loadWithCreate(clock: { now: number }) {
        const tabs: Array<{ id: number; url: string; active: boolean; focused?: boolean }> = [{ id: 1, url: "https://mail.example.com/", active: true, focused: true }];
        let next = 10;
        const chrome = {
            tabs: {
                get: async (id: number) => {
                    const t = tabs.find((x) => x.id === id);
                    if (!t) throw new Error("No tab");
                    return t;
                },
                query: async () => tabs.filter((t) => t.active && t.focused),
                create: async ({ url }: { url: string }) => {
                    for (const x of tabs) x.active = false;
                    const t = { id: next++, url, active: true, focused: true };
                    tabs.push(t);
                    return t;
                },
                update: async (id: number, { url }: { url: string }) => {
                    const t = tabs.find((x) => x.id === id) as { url: string };
                    t.url = url;
                    return t;
                },
            },
        };
        const api = new Function("chrome", "Date", `${block}; return { openPageInNewTab };`)(chrome, { now: () => clock.now }) as {
            openPageInNewTab: (url: string) => Promise<{ id: number }>;
        };
        return { tabs, ...api };
    }

    it("a new task reuses the tab Bhai opened last time instead of piling up tabs", async () => {
        const clock = { now: 0 };
        const { tabs, openPageInNewTab } = loadWithCreate(clock);
        const first = await openPageInNewTab("https://news.ycombinator.com/");
        clock.now += 30_000;
        const second = await openPageInNewTab("https://example.org/"); // same task: a second tab
        expect(second.id).not.toBe(first.id);
        clock.now += 300_000; // a later task
        const third = await openPageInNewTab("https://nodejs.org/");
        expect(third.id).toBe(first.id); // the one in front (second) may still be being read
        expect(tabs).toHaveLength(3); // the owner's tab + Bhai's two, not four
    });

    it("leaves a tab the owner took elsewhere alone", async () => {
        const clock = { now: 0 };
        const { tabs, openPageInNewTab } = loadWithCreate(clock);
        const first = await openPageInNewTab("https://news.ycombinator.com/");
        (tabs.find((t) => t.id === first.id) as { url: string }).url = "https://youtube.com/watch?v=x"; // the owner used it
        clock.now += 300_000;
        const next = await openPageInNewTab("https://nodejs.org/");
        expect(next.id).not.toBe(first.id);
    });
});
