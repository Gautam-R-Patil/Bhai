// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A background research's progress isn't a turn's status line, and reads as written;
// a note that happens to say "✅ … sources" isn't a finished research.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-research-status-"));
process.env.BHAI_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000));

const chat = await import("./overlay-chat.js");
const { createNotify } = await import("../research/index.js");
chat.initOverlayChat({} as never);

it("sends research progress as research_status, unchanged, and plain notes as notifications only", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.BHAI_OVERLAY_PORT}/?localToken=${chat.getOverlayLocalToken()}`);
    const seen: Array<{ type: string; text?: string }> = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));

    const failed = `❌ Research on "EV prices" failed: timeout`;
    await createNotify()(failed);
    await vi.waitFor(() => expect(seen).toContainEqual({ type: "research_status", text: failed }));

    await chat.sendOverlayNotification("✅ Checked 3 sources for your flight", { requested: true });
    await vi.waitFor(() => expect(seen.some((m) => m.type === "notification")).toBe(true));
    expect(seen.filter((m) => m.type === "progress" || m.type === "research_complete")).toEqual([]);
    ws.close();
}, 20_000);

it("the chat bar shows a research's status only on a free card, and clears only its own", async () => {
    const html = fs.readFileSync(path.join(__dirname, "overlay.html"), "utf8");
    const pick = (re: RegExp) => html.match(re)?.[0] ?? "";
    const code = [
        pick(/ {6}function esc\(t\) .*\n/),
        pick(/ {6}let researchStatusTimer = null;\n/),
        pick(/ {6}function showResearchStatus\(text\) \{[\s\S]*?\n {6}\}\n/),
        pick(/ {6}function clearResearchStatus\(\) \{[\s\S]*?\n {6}\}\n/),
    ].join("");
    const visible = new Set<string>();
    const progress = {
        innerHTML: "",
        classList: { add: (c: string) => visible.add(c), remove: (c: string) => visible.delete(c), contains: (c: string) => visible.has(c) },
        querySelector: (s: string) => (progress.innerHTML.includes(s.slice(1)) ? {} : null),
    };
    let fire = () => {};
    const ctx = vm.createContext({ progress, waiting: false, turnRunning: () => ctx.waiting, setTimeout: (f: () => void) => ((fire = f), 1), clearTimeout: () => {} });
    vm.runInContext(code, ctx);
    const run = (s: string) => vm.runInContext(s, ctx);

    run(`showResearchStatus("🔬 Round 1")`);
    expect(progress.innerHTML).toContain("Round 1");
    fire(); // a research that ended unseen doesn't leave its dots up
    expect(progress.innerHTML).toBe("");

    ctx.waiting = true;
    run(`showResearchStatus("🔬 Round 2")`);
    expect(progress.innerHTML).toBe("");
    progress.innerHTML = "turn card";
    run(`clearResearchStatus()`);
    expect(progress.innerHTML).toBe("turn card");

    ctx.waiting = false; // the lost-reply notice stays, through a research's status and end
    progress.innerHTML = "🔌 I lost my reply";
    visible.add("visible");
    run(`showResearchStatus("🔬 Round 3"); clearResearchStatus()`);
    expect(progress.innerHTML).toBe("🔌 I lost my reply");
});
