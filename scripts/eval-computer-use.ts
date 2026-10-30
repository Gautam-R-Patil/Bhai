// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.
//
// Computer-use eval (macOS): Bhai's real tool router, tools and macOS rules, driven by a
// hosted model through 12 everyday tasks. Each task is checked against real machine state
// (what's playing, the volume, the open Settings page, the Calculator display...) and then
// restored. Measures pass rate, steps, seconds and dollars per task, so a change to a tool,
// a description or the routing can be compared across models.
//
//   MODEL=gpt-4.1-nano AZ_ENDPOINT=... AZ_KEY=... npx tsx scripts/eval-computer-use.ts [taskId...]
//   MODEL=claude-haiku-5-5 ANTHROPIC_API_KEY=... npx tsx scripts/eval-computer-use.ts
//
// It drives this Mac's screen, music apps and settings: run it when nobody is using the
// machine. Only computer-use tools run (no shell, no AppleScript, no Wi-Fi toggles), and
// clicks/typing are refused while a terminal is in front. Results append to OUT
// (default data/eval-computer-use.jsonl). Spotify and Apple Music tasks need those apps signed in.
import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { executeTool } from "../src/tools/index.js";
import { initToolRouter, selectTools, setToolRouterLLM } from "../src/tool-router.js";
import { ackWithoutAction } from "../src/agent.js";
import { getFrontmostApp } from "../src/screen/frontmost.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ex = promisify(execFile);
const as = async (s: string) => (await ex("osascript", ["-e", s]).catch((e) => ({ stdout: `ERR ${e.message}` }))).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.env.MODEL ?? "gpt-4.1-nano";
const OUT = process.env.OUT ?? join(ROOT, "data/eval-computer-use.jsonl");
const REPO = basename(ROOT);

const ALLOWED = new Set([
    "spotify", "music_control", "set_volume", "open_settings", "dark_mode", "clipboard", "system_info",
    "find_files", "open_in_app", "app_manager", "window_manage", "os_smart_click", "os_inspect", "os_click_id",
    "os_type", "os_screenshot", "os_click", "os_visual_verify", "os_keyboard_shortcuts", "os_context",
    "list_directory", "glob", "get_current_time", "bluetooth_control", "wifi_control",
]);
const SCREEN_DRIVERS = new Set(["os_smart_click", "os_click_id", "os_type", "os_click"]);
const SHIELD = /terminal|iterm|claude|code|warp|ghostty/i;

async function guardedExec(name: string, args: Record<string, unknown>): Promise<string> {
    if (!ALLOWED.has(name)) return JSON.stringify({ error: `${name} is not available in this test` });
    if ((name === "wifi_control" || name === "bluetooth_control") && args.action !== "status")
        return JSON.stringify({ error: "only status is allowed in this test" });
    if (SCREEN_DRIVERS.has(name)) {
        const f = await getFrontmostApp();
        if (f && SHIELD.test(f.name)) return JSON.stringify({ error: `The frontmost app is ${f.name}. Bring the target app forward first with app_manager action=activate.` });
    }
    const r = await executeTool(name, args);
    return r.replace(/"(screenshot_base64|zoomed_base64)":"[^"]+"/g, '"$1":"[image omitted: no vision]"').slice(0, 3500);
}

type Task = { id: string; prompt: string; setup?: () => Promise<void>; check: (reply: string) => Promise<boolean>; cleanup?: () => Promise<void> };
let vol0 = 43;
const TASKS: Task[] = [
    { id: "spotify_play", prompt: "Play Levitating by Dua Lipa on Spotify",
      check: async () => /levitating/i.test(await as('tell application "Spotify" to if player state is playing then name of current track')),
      cleanup: async () => void (await as('tell application "Spotify" to pause')) },
    { id: "apple_music_play", prompt: "Play Starboy by The Weeknd on Apple Music",
      check: async () => /starboy/i.test(await as('tell application "Music" to if player state is playing then name of current track')),
      cleanup: async () => void (await as('tell application "Music" to pause')) },
    { id: "now_playing", prompt: "What song is playing on Spotify right now?",
      setup: async () => { await as('tell application "Spotify" to play track "spotify:track:0VjIjW4GlUZAMYd2vXMi3b"'); await sleep(1500); },
      check: async (reply) => /blinding lights/i.test(reply),
      cleanup: async () => void (await as('tell application "Spotify" to pause')) },
    { id: "light_mode", prompt: "Switch my Mac to light mode",
      check: async () => !(await ex("defaults", ["read", "-g", "AppleInterfaceStyle"]).then((r) => r.stdout.includes("Dark"), () => false)),
      cleanup: async () => void (await as('tell application "System Events" to tell appearance preferences to set dark mode to true')) },
    { id: "volume", prompt: "Set the volume to 25 percent",
      setup: async () => { vol0 = Number(await as("output volume of (get volume settings)")) || 43; },
      check: async () => Math.abs(Number(await as("output volume of (get volume settings)")) - 25) <= 2,
      cleanup: async () => void (await as(`set volume output volume ${vol0}`)) },
    { id: "bluetooth_settings", prompt: "Open the Bluetooth settings",
      check: async () => /bluetooth/i.test(await as('tell application "System Events" to tell process "System Settings" to get name of window 1')),
      cleanup: async () => void (await as('tell application "System Settings" to quit')) },
    { id: "camera_permissions", prompt: "Show me which apps are allowed to use my camera",
      check: async () => (await sleep(1200), /camera/i.test(await as('tell application "System Events" to tell process "System Settings" to get name of window 1'))),
      cleanup: async () => void (await as('tell application "System Settings" to quit')) },
    { id: "find_open_file", prompt: `Find the file CLAUDE.md in the ${REPO} folder and open it in TextEdit`,
      check: async () => /CLAUDE\.md/i.test(await as('tell application "TextEdit" to get name of every document')),
      cleanup: async () => void (await as('tell application "TextEdit" to quit saving no')) },
    { id: "downloads_folder", prompt: "Open my Downloads folder in Finder",
      check: async () => /downloads/i.test(await as('tell application "Finder" to get name of front window')),
      cleanup: async () => void (await as('tell application "Finder" to close front window')) },
    { id: "quit_app", prompt: "Quit the Calculator app",
      setup: async () => { await ex("open", ["-a", "Calculator"]); await sleep(1500); },
      check: async () => (await sleep(800), (await as('application "Calculator" is running')) === "false") },
    { id: "calculator_multistep", prompt: "Open the Calculator app and use it to calculate 45 times 12",
      setup: async () => { await ex("open", ["-a", "Calculator"]); await sleep(1200); await as('tell application "System Events" to key code 53'); await as('tell application "System Events" to key code 53'); await as('tell application "Calculator" to quit'); await sleep(800); },
      check: async () => { await as('tell application "Calculator" to activate'); await sleep(300); await as('tell application "System Events" to keystroke "c" using command down'); await sleep(300); const v = (await ex("pbpaste", [])).stdout.trim(); return /^540$/.test(v); },
      cleanup: async () => void (await as('tell application "Calculator" to quit')) },
    { id: "textedit_type", prompt: "Open TextEdit, make a new document and type: hello from bhai",
      setup: async () => { await as('tell application "TextEdit" to close every document saving no'); await as('tell application "TextEdit" to quit'); await sleep(800); },
      check: async () => /hello from bhai/i.test(await as('tell application "TextEdit" to get text of front document')),
      cleanup: async () => void (await as('tell application "TextEdit" to close every document saving no\ntell application "TextEdit" to quit')) },
];

const SYSTEM = [
    "You are Bhai, an AI assistant that controls the user's Mac with tools. Do the task yourself with tool calls, then reply with one short sentence saying what you did. Never ask the user to do it.",
    readFileSync(join(ROOT, "prompts/rules.md"), "utf8"),
    readFileSync(join(ROOT, "prompts/rules-mac.md"), "utf8"),
].join("\n\n");

// USD per 1M tokens: input, cached input, output (Azure retail, global standard, 2026-10-30).
const PRICES: Record<string, [number, number, number]> = {
    "gpt-5-nano": [0.05, 0.005, 0.4], "gpt-4.1-nano": [0.1, 0.025, 0.4], "gpt-4o-mini": [0.15, 0.075, 0.6],
    "gpt-5-mini": [0.25, 0.025, 2], "gpt-6.1-terra": [1, 0.05, 5], "gpt-6-astra": [10, 1, 50],
    "claude-haiku-5-5": [0.1, 0.01, 0.5], // cache writes billed at 1.25x input, counted below
};
const usage = { in: 0, cached: 0, out: 0 };
const REASONING = process.env.REASONING_EFFORT ?? (/^gpt-6/.test(MODEL) ? "none" : undefined);
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
async function chat(messages: unknown[], tools: unknown[]): Promise<{ message: { role: string; content: string | null; tool_calls?: ToolCall[] } }> {
    for (let attempt = 0; attempt < 4; attempt++) {
        const r = await fetch(`${process.env.AZ_ENDPOINT}/chat/completions`, {
            method: "POST",
            headers: { "api-key": process.env.AZ_KEY ?? "", "content-type": "application/json" },
            // GPT-6 models take function tools on chat completions only with reasoning off.
            body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", ...(REASONING ? { reasoning_effort: REASONING } : {}) }),
        });
        const d = (await r.json()) as { choices?: { message: never }[]; error?: { message: string }; usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } };
        if (d.choices) {
            const c = d.usage?.prompt_tokens_details?.cached_tokens ?? 0;
            usage.in += (d.usage?.prompt_tokens ?? 0) - c; usage.cached += c; usage.out += d.usage?.completion_tokens ?? 0;
            return { message: d.choices[0].message };
        }
        if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
        throw new Error(d.error?.message ?? `HTTP ${r.status}`);
    }
    throw new Error("rate limited");
}

// Claude, the way Bhai's proxy calls Haiku on simple desktop turns: adaptive thinking, effort low.
const anthropic = MODEL.startsWith("claude-") ? new Anthropic() : null;
async function claudeLoop(system: string, prompt: string, tools: any[], used: string[], trace: string[]): Promise<{ reply: string; iters: number }> {
    const atools = tools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object" } }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    let acked = false;
    for (let i = 0; i < 10; i++) {
        const res = await anthropic!.messages.create({
            model: MODEL, max_tokens: 16000, system, tools: atools as Anthropic.Tool[], messages,
            output_config: { effort: "low" }, cache_control: { type: "ephemeral" },
        } as never);
        const u = res.usage as unknown as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        usage.in += u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25; usage.cached += u.cache_read_input_tokens ?? 0; usage.out += u.output_tokens;
        messages.push({ role: "assistant", content: res.content });
        const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (res.stop_reason !== "tool_use" || !calls.length) {
            const reply = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join(" ");
            if (!acked && ackWithoutAction(reply, used.length)) { // as the agent loop does
                acked = true;
                messages.push({ role: "user", content: "You said what you'll do but made no tool call, so nothing has happened yet. Do it now with your tools, then tell me the result." });
                continue;
            }
            return { reply, iters: i + 1 };
        }
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const c of calls) {
            used.push(c.name);
            const out = await guardedExec(c.name, c.input as Record<string, unknown>);
            trace.push(`${c.name}(${JSON.stringify(c.input).slice(0, 140)}) → ${out.slice(0, 220)}`);
            results.push({ type: "tool_result", tool_use_id: c.id, content: out });
        }
        messages.push({ role: "user", content: results });
    }
    return { reply: "", iters: 10 };
}

await initToolRouter();
setToolRouterLLM({ chat: () => new Promise(() => {}) } as never);
const only = process.argv.slice(2);
const results = [];
for (const task of TASKS.filter((t) => !only.length || only.includes(t.id))) {
    await task.setup?.();
    await ex("open", ["-a", "Finder"]); // never leave a terminal in front
    await sleep(400);
    const sel = await selectTools({ message: task.prompt, iteration: 1 });
    const tools = sel.tools.filter((t) => ALLOWED.has(t.function.name));
    const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
    const used: string[] = [];
    const trace: string[] = [];
    const t0 = Date.now();
    usage.in = usage.cached = usage.out = 0;
    let reply = "";
    let acked = false;
    let iters = 0;
    if (anthropic) {
        const r = await claudeLoop(SYSTEM, task.prompt, tools, used, trace);
        reply = r.reply;
        iters = r.iters - 1;
    } else for (; iters < 10; iters++) {
        const res = await chat(messages, tools);
        const m = res.message;
        messages.push(m);
        if (!m.tool_calls?.length) {
            reply = m.content ?? "";
            if (!acked && ackWithoutAction(reply, used.length)) { // as the agent loop does
                acked = true;
                messages.push({ role: "user", content: "You said what you'll do but made no tool call, so nothing has happened yet. Do it now with your tools, then tell me the result." });
                continue;
            }
            break;
        }
        for (const tc of m.tool_calls) {
            used.push(tc.function.name);
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* model sent bad JSON */ }
            const out = await guardedExec(tc.function.name, args);
            trace.push(`${tc.function.name}(${JSON.stringify(args).slice(0, 140)}) → ${out.slice(0, 220)}`);
            messages.push({ role: "tool", tool_call_id: tc.id, content: out });
        }
    }
    const ms = Date.now() - t0;
    const ok = await task.check(reply).catch(() => false);
    await task.cleanup?.().catch(() => {});
    const pr = PRICES[MODEL];
    const cost = pr ? (usage.in * pr[0] + usage.cached * pr[1] + usage.out * pr[2]) / 1e6 : null;
    const row = { model: MODEL, task: task.id, ok, tokens: { ...usage }, cost, iters: iters + 1, toolCalls: used.length, used, ms, offered: tools.map((t) => t.function.name).length, reply: reply.slice(0, 160), trace, offeredNames: tools.map((t) => t.function.name) };
    results.push(row);
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    if (!ok) for (const t of trace) console.log("     · " + t);
    console.log(`${ok ? "✅" : "❌"} ${task.id.padEnd(22)} iters=${row.iters} calls=${used.length} ${ms}ms $${cost?.toFixed(5) ?? "?"} [${used.join(",")}] ${reply.slice(0, 80).replace(/\n/g, " ")}`);
    await sleep(500);
}
console.log(`SCORE ${MODEL}: ${results.filter((r) => r.ok).length}/${results.length}`);
process.exit(0);
