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
//   RECORD=1 ...   also adds each result to the learned router's evidence (data/router-stats.json)
//
// It drives this Mac's screen, music apps and settings: run it when nobody is using the
// machine. Only computer-use tools run (no shell, no AppleScript, no Wi-Fi toggles), and
// clicks/typing are refused while a terminal is in front. Results append to OUT
// (default data/eval-computer-use.jsonl). Spotify and Apple Music tasks need those apps signed in.
import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { executeTool } from "../src/tools/index.js";
import { initToolRouter, selectTools, setDecisionTransport, setToolRouterLLM } from "../src/tool-router.js";
import { ackWithoutAction } from "../src/agent.js";
import { resolveHomePath } from "../src/tools/file-utils.js";
import { runQuickCommand } from "../src/quick-commands.js";
import { ARMS, chooseArm, classifyTurn, recordOutcome } from "../src/routing/learned-router.js";
import { getFrontmostApp } from "../src/screen/frontmost.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ex = promisify(execFile);
const as = async (s: string) => (await ex("osascript", ["-e", s]).catch((e) => ({ stdout: `ERR ${e.message}` }))).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = process.env.MODEL ?? "gpt-4.1-nano";
// MODEL=router: the learned router (src/routing/learned-router.ts) picks each task's model from
// the real tool-router classification, as the agent loop does.
const ROUTER = MODEL === "router";
let model = MODEL; // this task's model
const OUT = process.env.OUT ?? join(ROOT, "data/eval-computer-use.jsonl");
const REPO = basename(ROOT);

const ALLOWED = new Set([
    "spotify", "music_control", "set_volume", "open_settings", "dark_mode", "clipboard", "system_info",
    "find_files", "open_in_app", "app_manager", "window_manage", "os_smart_click", "os_inspect", "os_click_id",
    "os_type", "os_screenshot", "os_click", "os_visual_verify", "os_keyboard_shortcuts", "os_context",
    "list_directory", "glob", "get_current_time", "bluetooth_control", "wifi_control",
    "write", "append_file", "compress_files", "file_manage", "image_edit", "pdf_edit", "calculator", "read", "file_metadata", "apple_notes", "reminders_tool", "calendar_tool",
    "browser_navigate", "browser_extract", "browser_extract_article", "browser_scan", "browser_click", "browser_type",
    "browser_scroll", "browser_wait", "browser_back", "browser_close",
]);
const SCREEN_DRIVERS = new Set(["os_smart_click", "os_click_id", "os_type", "os_click"]);
const SHIELD = /terminal|iterm|claude|code|warp|ghostty/i;

async function guardedExec(name: string, args: Record<string, unknown>): Promise<string> {
    if (!ALLOWED.has(name)) return JSON.stringify({ error: `${name} is not available in this test` });
    if ((name === "wifi_control" || name === "bluetooth_control") && args.action !== "status")
        return JSON.stringify({ error: "only status is allowed in this test" });
    // Writes stay in the sandbox folder; nothing is deleted.
    if (["write", "append_file", "compress_files", "file_manage", "image_edit", "pdf_edit"].includes(name)) {
        // image_edit/pdf_edit write their output, not their source (a source that isn't there gets
        // corrected to the file of that name nearby, in the sandbox).
        const media = name === "image_edit" || name === "pdf_edit";
        const src = String(args.path ?? (args.paths as string[] | undefined)?.[0] ?? "");
        const checked = media ? (args.output ? { output: args.output } : existsSync(resolveHomePath(src)) ? { src } : {}) : args;
        const paths = JSON.stringify(checked).match(/(?:~|\/Users\/)[^"]*/g) ?? [];
        // Resolved as Bhai resolves them (a placeholder home is the real one).
        if ((!paths.length && !media) || paths.some((p) => !resolveHomePath(p).startsWith(EVAL_DIR)))
            return JSON.stringify({ error: `In this test, files may only be written inside ${EVAL_DIR}` });
    }
    if ((name === "apple_notes" || name === "reminders_tool") && /delete|remove|move/.test(String(args.action)))
        return JSON.stringify({ error: "not available in this test" });
    if (SCREEN_DRIVERS.has(name)) {
        const f = await getFrontmostApp();
        if (f && SHIELD.test(f.name)) return JSON.stringify({ error: `The frontmost app is ${f.name}. Bring the target app forward first with app_manager action=activate.` });
    }
    const r = await executeTool(name, args);
    return r.replace(/"(screenshot_base64|zoomed_base64)":"[^"]+"/g, '"$1":"[image omitted: no vision]"').slice(0, 3500);
}

const EVAL_DIR = join(homedir(), "Desktop", "BhaiEval");
const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const newestPdf = () => {
    const dir = join(homedir(), "Downloads");
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f ?? "";
};
type Task = { id: string; prompt: string; setup?: () => Promise<void>; check: (reply: string, trace: string[]) => Promise<boolean>; cleanup?: () => Promise<void> };
/** A web page was actually read (not the answer from memory). */
const readPage = (trace: string[]) => trace.some((t) => /^browser_(navigate|extract|extract_article|scan)\(/.test(t) && !/"error"|"success":false/.test(t));
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
      cleanup: async () => void (await as('tell application "TextEdit" to close every document saving no')) },
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
      setup: async () => { await as('tell application "TextEdit" to close every document saving no'); await sleep(800); },
      check: async () => /hello from bhai/i.test(await as('tell application "TextEdit" to get text of front document')),
      cleanup: async () => void (await as('tell application "TextEdit" to close every document saving no')) },
    // ── Multi-step and multi-app ──
    { id: "chain_settings", prompt: "Set the volume to 30 percent, switch my Mac to light mode, and open the Bluetooth settings",
      setup: async () => { vol0 = Number(await as("output volume of (get volume settings)")) || 43; },
      check: async () => {
          await sleep(800);
          const vol = Math.abs(Number(await as("output volume of (get volume settings)")) - 30) <= 2;
          const light = !(await ex("defaults", ["read", "-g", "AppleInterfaceStyle"]).then((r) => r.stdout.includes("Dark"), () => false));
          const bt = /bluetooth/i.test(await as('tell application "System Events" to tell process "System Settings" to get name of window 1'));
          return vol && light && bt;
      },
      cleanup: async () => { await as(`set volume output volume ${vol0}`); await as('tell application "System Events" to tell appearance preferences to set dark mode to true'); await as('tell application "System Settings" to quit'); } },
    { id: "calc_to_textedit", prompt: "Use the Calculator app to work out 123 times 45, then open a new TextEdit document and write the result in it",
      setup: async () => { await as('tell application "TextEdit" to close every document saving no'); await as('tell application "Calculator" to quit'); await sleep(800); },
      check: async () => /5,?535/.test(await as('tell application "TextEdit" to get text of front document')),
      cleanup: async () => { await as('tell application "TextEdit" to close every document saving no'); await as('tell application "Calculator" to quit'); } },
    { id: "newest_pdf", prompt: "What is the newest PDF file in my Downloads folder? Tell me its file name.",
      check: async (reply) => {
          const dir = join(homedir(), "Downloads");
          const pdfs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
          const flat = (t: string) => t.toLowerCase().replace(/\.pdf$/, "").replace(/[^a-z0-9]/g, "");
          return !!pdfs[0] && flat(reply).includes(flat(pdfs[0].f));
      } },
    { id: "playlist_and_tell", prompt: "Play my Favourite Songs playlist in Apple Music and tell me which song is playing",
      check: async (reply) => {
          const pl = await as('tell application "Music" to if player state is playing then name of current playlist');
          const track = await as('tell application "Music" to if player state is playing then name of current track');
          return /favourite songs/i.test(pl) && !!track && reply.toLowerCase().includes(track.toLowerCase().replace(/\s*\(.*$/, ""));
      },
      cleanup: async () => void (await as('tell application "Music" to pause')) },
    { id: "switch_players", prompt: "Pause Spotify and play Blinding Lights by The Weeknd on Apple Music instead",
      setup: async () => { await as('tell application "Spotify" to play track "spotify:track:39LLxExYz6ewLAcYrzQQyP"'); await sleep(1500); },
      check: async () => (await as('tell application "Spotify" to player state as string')) !== "playing" && /blinding lights/i.test(await as('tell application "Music" to if player state is playing then name of current track')),
      cleanup: async () => { await as('tell application "Music" to pause'); await as('tell application "Spotify" to pause'); } },
    // ── Files (sandboxed in ~/Desktop/BhaiEval), clipboard, system ──
    { id: "write_file", prompt: "Create a text file called todo.txt in the BhaiEval folder on my Desktop with the text: buy milk",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); },
      check: async () => { try { return /buy milk/i.test(readFileSync(join(EVAL_DIR, "todo.txt"), "utf8")); } catch { return false; } } },
    { id: "zip_folder", prompt: "Zip the BhaiEval folder on my Desktop and save the zip inside that folder",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); writeFileSync(join(EVAL_DIR, "notes.txt"), "eval"); },
      check: async () => readdirSync(EVAL_DIR).some((f) => f.toLowerCase().endsWith(".zip")) },
    { id: "count_pdfs", prompt: "How many PDF files are in my Downloads folder?",
      check: async (reply) => {
          const n = readdirSync(join(homedir(), "Downloads")).filter((f) => f.toLowerCase().endsWith(".pdf")).length;
          return new RegExp(`\\b${n}\\b`).test(reply.replace(/,/g, ""));
      } },
    { id: "clipboard_copy", prompt: "Copy the text 'bhai clipboard test' to my clipboard",
      setup: async () => void (await ex("bash", ["-c", "printf x | pbcopy"])),
      check: async () => (await ex("pbpaste", [])).stdout.trim() === "bhai clipboard test" },
    { id: "pdf_name_to_clipboard", prompt: "Find the newest PDF in my Downloads folder and copy its file name to my clipboard",
      setup: async () => void (await ex("bash", ["-c", "printf x | pbcopy"])),
      check: async () => { const want = flat(newestPdf().replace(/\.pdf$/i, "")); return !!want && flat((await ex("pbpaste", [])).stdout).includes(want); } },
    { id: "disk_space", prompt: "How much free disk space do I have?",
      check: async (reply) => {
          const freeGb = Number((await ex("df", ["-g", "/System/Volumes/Data"])).stdout.trim().split("\n")[1].split(/\s+/)[3]);
          return (reply.match(/(\d+(?:\.\d+)?)\s*(GB|GiB|gigabytes)/gi) ?? []).some((m) => Math.abs(Number.parseFloat(m) - freeGb) <= Math.max(3, freeGb * 0.15));
      } },
    // ── Apps with their own tools ──
    { id: "notes_create", prompt: "Create a note in Apple Notes titled 'Bhai eval note' that says: it works",
      check: async () => /it works/i.test(await as('tell application "Notes" to get body of first note whose name contains "Bhai eval note"')),
      cleanup: async () => void (await as('tell application "Notes" to delete (every note whose name contains "Bhai eval note")')) },
    { id: "reminder_create", prompt: "Remind me tomorrow at 9am to water the plants",
      check: async () => /water the plants/i.test(await as('tell application "Reminders" to get name of (every reminder whose name contains "water the plants")')),
      cleanup: async () => void (await as('tell application "Reminders" to delete (every reminder whose name contains "water the plants")')) },
    // ── Web pages (Bhai's own browser) ──
    { id: "browser_heading", prompt: "Open example.com in the browser and tell me the page's title",
      check: async (reply, trace) => readPage(trace) && /example domain/i.test(reply) },
    { id: "browser_fact", prompt: "Open the Wikipedia page for Alan Turing and tell me the year he was born",
      check: async (reply, trace) => readPage(trace) && /\b1912\b/.test(reply),
      cleanup: async () => void (await guardedExec("browser_close", {})) },
    // ── Harder: several steps, computed results ──
    { id: "organize_pdfs", prompt: "In the BhaiEval folder on my Desktop, make a folder called PDFs and move all the PDF files into it",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); for (const f of ["a.pdf", "b.pdf", "notes.txt"]) writeFileSync(join(EVAL_DIR, f), f); },
      check: async () => { try { return readdirSync(join(EVAL_DIR, "PDFs")).sort().join() === "a.pdf,b.pdf" && !readdirSync(EVAL_DIR).some((f) => f.endsWith(".pdf")); } catch { return false; } } },
    { id: "rename_file", prompt: "Rename notes.txt in the BhaiEval folder on my Desktop to notes-old.txt",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); writeFileSync(join(EVAL_DIR, "notes.txt"), "eval"); rmSync(join(EVAL_DIR, "notes-old.txt"), { force: true }); },
      check: async () => readdirSync(EVAL_DIR).includes("notes-old.txt") && !readdirSync(EVAL_DIR).includes("notes.txt") },
    { id: "count_to_file", prompt: "Count the .txt files in the BhaiEval folder on my Desktop and write the number into a file called count.txt in that folder",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); for (const f of ["a.txt", "b.txt", "c.txt", "d.md"]) writeFileSync(join(EVAL_DIR, f), f); },
      check: async () => { try { return /\b3\b/.test(readFileSync(join(EVAL_DIR, "count.txt"), "utf8")); } catch { return false; } } },
    { id: "date_to_file", prompt: "Write today's date into a file called today.txt in the BhaiEval folder on my Desktop",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); rmSync(join(EVAL_DIR, "today.txt"), { force: true }); },
      check: async () => {
          let t = ""; try { t = readFileSync(join(EVAL_DIR, "today.txt"), "utf8"); } catch { return false; }
          const d = new Date(); const mon = d.toLocaleString("en", { month: "long" }); const day = d.getDate(); const y = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, "0"), dd = String(day).padStart(2, "0");
          return [`${y}-${mm}-${dd}`, `${mon} ${day}`, `${day} ${mon}`, `${mm}/${dd}/${y}`, `${dd}/${mm}/${y}`].some((f) => t.includes(f));
      } },
    { id: "largest_download", prompt: "Which file in my Downloads folder is the largest? Tell me its name.",
      check: async (reply) => {
          const dir = join(homedir(), "Downloads");
          const files = readdirSync(dir).map((f) => { try { const st = statSync(join(dir, f)); return st.isFile() ? { f, s: st.size } : null; } catch { return null; } }).filter(Boolean).sort((a, b) => b!.s - a!.s);
          const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
          return !!files[0] && flat(reply).includes(flat(files[0]!.f.replace(/\.[^.]+$/, "")));
      } },
    { id: "note_list", prompt: "Create a note in Apple Notes titled Groceries that lists milk, eggs and bread",
      setup: async () => void (await as('tell application "Notes" to delete (every note whose name is "Groceries")')),
      check: async () => { const b = (await as('tell application "Notes" to get body of first note whose name is "Groceries"')).toLowerCase(); return ["milk", "eggs", "bread"].every((w) => b.includes(w)); },
      cleanup: async () => void (await as('tell application "Notes" to delete (every note whose name is "Groceries")')) },
    { id: "wiki_two_facts", prompt: "Open the Wikipedia page for Ada Lovelace and tell me the year she was born and the year she died",
      check: async (reply, trace) => readPage(trace) && /\b1815\b/.test(reply) && /\b1852\b/.test(reply),
      cleanup: async () => void (await guardedExec("browser_close", {})) },
    // ── Images, PDFs, archives ──
    { id: "image_convert", prompt: "Convert photo.png in the BhaiEval folder on my Desktop to a JPG",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); await (await import("sharp")).default({ create: { width: 400, height: 200, channels: 3, background: "#3366ff" } }).png().toFile(join(EVAL_DIR, "photo.png")); },
      check: async () => readdirSync(EVAL_DIR).some((f) => /\.jpe?g$/i.test(f) && readFileSync(join(EVAL_DIR, f)).subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) },
    { id: "image_resize", prompt: "Make photo.png in the BhaiEval folder on my Desktop 100 pixels wide",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); await (await import("sharp")).default({ create: { width: 400, height: 200, channels: 3, background: "#3366ff" } }).png().toFile(join(EVAL_DIR, "photo.png")); },
      check: async () => { const sharp = (await import("sharp")).default; for (const f of readdirSync(EVAL_DIR)) if (/\.(png|jpe?g)$/i.test(f) && (await sharp(join(EVAL_DIR, f)).metadata()).width === 100) return true; return false; } },
    { id: "pdf_merge", prompt: "Combine a.pdf and b.pdf in the BhaiEval folder on my Desktop into one PDF called both.pdf",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); const { PDFDocument } = await import("pdf-lib"); for (const [n, k] of [["a.pdf", 2], ["b.pdf", 3]] as const) { const d = await PDFDocument.create(); for (let i = 0; i < k; i++) d.addPage(); writeFileSync(join(EVAL_DIR, n), await d.save()); } },
      check: async () => { try { const { PDFDocument } = await import("pdf-lib"); return (await PDFDocument.load(readFileSync(join(EVAL_DIR, "both.pdf")))).getPageCount() === 5; } catch { return false; } } },
    { id: "pdf_pages", prompt: "How many pages does b.pdf in the BhaiEval folder on my Desktop have?",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); const { PDFDocument } = await import("pdf-lib"); const d = await PDFDocument.create(); for (let i = 0; i < 3; i++) d.addPage(); writeFileSync(join(EVAL_DIR, "b.pdf"), await d.save()); },
      check: async (reply) => /\b(3|three)\b/i.test(reply) },
    { id: "unzip", prompt: "Unzip pack.zip in the BhaiEval folder on my Desktop",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(join(EVAL_DIR, "pack"), { recursive: true }); writeFileSync(join(EVAL_DIR, "pack", "hello.txt"), "hi"); await ex("ditto", ["-c", "-k", "--keepParent", join(EVAL_DIR, "pack"), join(EVAL_DIR, "pack.zip")]); rmSync(join(EVAL_DIR, "pack"), { recursive: true }); },
      check: async () => { const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [e.name]); return walk(EVAL_DIR).includes("hello.txt"); } },
    // ── Longer: several steps across apps, the web and files ──
    { id: "web_to_file", prompt: "Look up on Wikipedia the year the Eiffel Tower was completed and save just that year in a file called eiffel.txt in the BhaiEval folder on my Desktop",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); rmSync(join(EVAL_DIR, "eiffel.txt"), { force: true }); },
      check: async (_r, trace) => { try { return readPage(trace) && /\b1889\b/.test(readFileSync(join(EVAL_DIR, "eiffel.txt"), "utf8")); } catch { return false; } },
      cleanup: async () => void (await guardedExec("browser_close", {})) },
    { id: "web_compare", prompt: "Using Wikipedia, find out whether France or Germany has the larger population and write the answer (just the country) into answer.txt in the BhaiEval folder on my Desktop",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); rmSync(join(EVAL_DIR, "answer.txt"), { force: true }); },
      check: async (_r, trace) => { try { const t = readFileSync(join(EVAL_DIR, "answer.txt"), "utf8"); return readPage(trace) && /germany/i.test(t) && !/france/i.test(t); } catch { return false; } },
      cleanup: async () => void (await guardedExec("browser_close", {})) },
    { id: "list_to_file", prompt: "List the PDF files in the BhaiEval folder on my Desktop and write their names, one per line, into pdfs.txt in that folder",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); for (const f of ["report.pdf", "invoice.pdf", "notes.txt"]) writeFileSync(join(EVAL_DIR, f), f); },
      check: async () => { try { const t = readFileSync(join(EVAL_DIR, "pdfs.txt"), "utf8"); return /report\.pdf/.test(t) && /invoice\.pdf/.test(t) && !/notes\.txt/.test(t); } catch { return false; } } },
    { id: "sort_by_type", prompt: "Sort the files in the BhaiEval folder on my Desktop into three folders by type: PDFs, Images and Text",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); for (const f of ["a.pdf", "b.png", "c.txt", "d.jpg", "e.md"]) writeFileSync(join(EVAL_DIR, f), f); },
      check: async () => { const has = (d: string, f: string) => { try { return readdirSync(join(EVAL_DIR, d)).includes(f); } catch { return false; } }; return has("PDFs", "a.pdf") && has("Images", "b.png") && has("Images", "d.jpg") && has("Text", "c.txt") && !readdirSync(EVAL_DIR).some((f) => /\.(pdf|png|jpg|txt)$/.test(f)); } },
    { id: "web_to_note", prompt: "Find the capital of Australia on Wikipedia and create an Apple Note titled Capital with the answer",
      setup: async () => void (await as('tell application "Notes" to delete (every note whose name is "Capital")')),
      check: async (_r, trace) => readPage(trace) && /canberra/i.test(await as('tell application "Notes" to get body of first note whose name is "Capital"')),
      cleanup: async () => { await as('tell application "Notes" to delete (every note whose name is "Capital")'); await guardedExec("browser_close", {}); } },
    { id: "calc_two_steps", prompt: "Use the Calculator app to work out 17 times 23, then add 100 to that result, and write the final answer in a new TextEdit document",
      setup: async () => { await as('tell application "TextEdit" to close every document saving no'); await as('tell application "Calculator" to quit'); await sleep(800); },
      check: async () => /\b491\b/.test(await as('tell application "TextEdit" to get text of front document')),
      cleanup: async () => { await as('tell application "TextEdit" to close every document saving no'); await as('tell application "Calculator" to quit'); } },
    { id: "version_to_file", prompt: "Find out which version of macOS I'm running and write it into version.txt in the BhaiEval folder on my Desktop",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); rmSync(join(EVAL_DIR, "version.txt"), { force: true }); },
      check: async () => { try { const v = (await ex("sw_vers", ["-productVersion"])).stdout.trim(); return readFileSync(join(EVAL_DIR, "version.txt"), "utf8").includes(v); } catch { return false; } } },
    { id: "edit_then_copy", prompt: "Add 'call mom' as a new line to todo.txt in the BhaiEval folder on my Desktop, then make a copy of it called todo-backup.txt in the same folder",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); writeFileSync(join(EVAL_DIR, "todo.txt"), "buy milk\n"); },
      check: async () => { try { const a = readFileSync(join(EVAL_DIR, "todo.txt"), "utf8"); const b = readFileSync(join(EVAL_DIR, "todo-backup.txt"), "utf8"); return /buy milk/.test(a) && /call mom/i.test(a) && /call mom/i.test(b) && /buy milk/.test(b); } catch { return false; } } },
    { id: "image_to_pdf", prompt: "Convert photo.png in the BhaiEval folder on my Desktop to a JPG, then make a PDF from that JPG",
      setup: async () => { rmSync(EVAL_DIR, { recursive: true, force: true }); mkdirSync(EVAL_DIR, { recursive: true }); await (await import("sharp")).default({ create: { width: 400, height: 200, channels: 3, background: "#3366ff" } }).png().toFile(join(EVAL_DIR, "photo.png")); },
      check: async () => { const fs = readdirSync(EVAL_DIR); return fs.some((f) => /\.jpe?g$/i.test(f)) && fs.some((f) => /\.pdf$/i.test(f) && readFileSync(join(EVAL_DIR, f)).subarray(0, 4).toString() === "%PDF"); } },
    { id: "file_to_reminder", prompt: "Read task.txt in the BhaiEval folder on my Desktop and create a reminder for tomorrow at 10am with its text",
      setup: async () => { mkdirSync(EVAL_DIR, { recursive: true }); writeFileSync(join(EVAL_DIR, "task.txt"), "renew the passport"); },
      check: async () => /renew the passport/i.test(await as('tell application "Reminders" to get name of (every reminder whose name contains "passport")')),
      cleanup: async () => void (await as('tell application "Reminders" to delete (every reminder whose name contains "passport")')) },
    { id: "calc_to_clipboard", prompt: "Use the Calculator app to work out 42 times 3, then copy the result to my clipboard",
      setup: async () => { await as('tell application "Calculator" to quit'); await as('set the clipboard to ""'); await sleep(600); },
      check: async () => /\b126\b/.test((await ex("pbpaste", [])).stdout),
      cleanup: async () => void (await as('tell application "Calculator" to quit')) },
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
    "claude-sonnet-5-5": [2, 0.2, 10],
};
const usage = { in: 0, cached: 0, out: 0 };
const reasoning = () => process.env.REASONING_EFFORT ?? (/^gpt-6/.test(model) ? "none" : undefined);
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
async function chat(messages: unknown[], tools: unknown[]): Promise<{ message: { role: string; content: string | null; tool_calls?: ToolCall[] } }> {
    for (let attempt = 0; attempt < 4; attempt++) {
        const r = await fetch(`${process.env.AZ_ENDPOINT}/chat/completions`, {
            method: "POST",
            headers: { "api-key": process.env.AZ_KEY ?? "", "content-type": "application/json" },
            // GPT-6 models take function tools on chat completions only with reasoning off.
            body: JSON.stringify({ model, messages, tools, tool_choice: "auto", ...(reasoning() ? { reasoning_effort: reasoning() } : {}) }),
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
const anthropicClient = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropicClient && (ROUTER || MODEL.startsWith("claude") || process.env.PLAN === "1")) {
    console.error("This run can pick a Claude model: set ANTHROPIC_API_KEY (npx convex env get ANTHROPIC_API_KEY).");
    process.exit(1);
}
async function claudeLoop(system: string, prompt: string, tools: any[], used: string[], trace: string[]): Promise<{ reply: string; iters: number }> {
    const atools = tools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object" } }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    let acked = false;
    for (let i = 0; i < 10; i++) {
        const res = await anthropicClient!.messages.create({
            model, max_tokens: 16000, system, tools: atools as Anthropic.Tool[], messages,
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

// The browser backend the bot registers at boot (src/index.ts).
{
    const { registerPlaywrightBackend } = await import("../src/tools/browser/index.js");
    const { PlaywrightPassthroughBackend } = await import("../src/tools/browser/playwright-backend.js");
    registerPlaywrightBackend(() => new PlaywrightPassthroughBackend());
}
await initToolRouter();
setToolRouterLLM(
    ROUTER
        ? ({
              chat: async (o: { messages: { role: string; content: string }[]; systemPrompt?: string }) => {
                  const r = await fetch(`${process.env.AZ_ENDPOINT}/chat/completions`, {
                      method: "POST",
                      headers: { "api-key": process.env.AZ_KEY ?? "", "content-type": "application/json" },
                      body: JSON.stringify({ model: "gpt-4.1-nano", messages: [{ role: "system", content: o.systemPrompt ?? "" }, ...o.messages] }),
                  });
                  return r.json();
              },
          } as never)
        : ({ chat: () => new Promise(() => {}) } as never),
);
if (ROUTER) process.env.ATLAS_TOOL_ROUTER_TIMEOUT_MS ??= "10000";
// DECISION_DEPLOYMENT=<name>: the classifier is Microsoft-Decision-1, called straight on Azure
// (in the app it goes through Convex /api/decide); otherwise no Decision step here.
setDecisionTransport(
    process.env.DECISION_DEPLOYMENT
        ? async (state, questions, timeoutMs) => {
              const res = await fetch(`${process.env.AZ_ENDPOINT?.replace(/\/openai\/v1\/?$/, "")}/providers/microsoft/v1/systemone`, {
                  method: "POST",
                  headers: { "api-key": process.env.AZ_KEY ?? "", "Content-Type": "application/json" },
                  body: JSON.stringify({ model: process.env.DECISION_DEPLOYMENT, state, questions }),
                  signal: AbortSignal.timeout(timeoutMs),
              });
              return ((await res.json()) as { answers?: never }).answers ?? null;
          }
        : null,
);
if (process.env.DECISION_DEPLOYMENT) process.env.ATLAS_TOOL_ROUTER_TIMEOUT_MS ??= "6000";
let planCost = 0; // PLAN=1: the planner's own cost, added to the task's
const only = process.argv.slice(2);
const results = [];
for (const task of TASKS.filter((t) => !only.length || only.includes(t.id))) {
    await task.setup?.();
    await ex("open", ["-a", "Finder"]); // never leave a terminal in front
    await sleep(400);
    const sel = await selectTools({ message: task.prompt, iteration: 1 });
    if (ROUTER) {
        // As the agent loop: complex work keeps Sonnet; everything else goes to the learned pick.
        const c = sel.classification;
        const arm = c?.tier === "complex" ? undefined : chooseArm(classifyTurn(c, false), { lowRisk: false }).arm;
        model = !arm ? "claude-sonnet-5-5" : arm.model.startsWith("azure/") ? arm.model.slice(6) : arm.id === "haiku" ? "claude-haiku-5-5" : "claude-sonnet-5-5";
        console.log(`     → ${c?.tier ?? "?"} ${classifyTurn(c, false)} → ${model}`);
    }
    const tools = sel.tools.filter((t) => ALLOWED.has(t.function.name));
    const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
    const used: string[] = [];
    const trace: string[] = [];
    const t0 = Date.now();
    usage.in = usage.cached = usage.out = 0;
    let reply = "";
    let acked = false;
    let iters = 0;
    // As the agent loop does: a message made only of everyday commands runs without a model.
    const quick = process.env.NO_QUICK === "1" ? null : await runQuickCommand(task.prompt, async (tool, args) => {
        used.push(tool);
        const out = await guardedExec(tool, args);
        trace.push(`${tool}(${JSON.stringify(args).slice(0, 140)}) → ${out.slice(0, 220)}`);
        return out;
    });
    if (quick?.reply) {
        reply = quick.reply;
        iters = -1; // no model call
    } else if (model.startsWith("claude-")) {
        const r = await claudeLoop(SYSTEM, task.prompt, tools, used, trace);
        reply = r.reply;
        iters = r.iters - 1;
    } else {
    // PLAN=1, as Bhai runs a cheap model on multi-step work: a stronger model writes the plan
    // (the orchestrator), and before "done" the model is sent back over it (the verify gate).
    const planned = process.env.PLAN === "1" && (task.prompt.length > 70 || /\b(then|and)\b/i.test(task.prompt));
    if (planned) {
        const r = await anthropicClient!.messages.create({
            model: "claude-haiku-5-5",
            max_tokens: 300,
            system: `You plan computer tasks for an assistant with these tools: ${tools.map((t) => t.function.name).join(", ")}. Reply with only a numbered list of at most 6 concrete steps (which tool, on what). Include every item the task names, and a last step that checks the result.`,
            messages: [{ role: "user", content: task.prompt }],
        });
        planCost += (r.usage.input_tokens * 0.1 + r.usage.output_tokens * 0.5) / 1e6;
        const plan = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        messages.push({ role: "user", content: `Plan for this task (do every step, one at a time):\n${plan}` });
    }
    let reviewed = false;
    for (; iters < 12; iters++) {
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
            if (planned && !reviewed) {
                reviewed = true;
                messages.push({ role: "user", content: "Before you finish, go through the plan: is every step done, for every item the task names? Check with a tool where unsure, and do anything missing now. Then reply with the result." });
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
    }
    const ms = Date.now() - t0;
    const ok = await task.check(reply, trace).catch(() => false);
    await task.cleanup?.().catch(() => {});
    const pr = PRICES[model];
    const cost = pr ? (usage.in * pr[0] + usage.cached * pr[1] + usage.out * pr[2]) / 1e6 + planCost : null;
    planCost = 0;
    const row = { model, routed: ROUTER || undefined, task: task.id, ok, tokens: { ...usage }, cost, iters: iters + 1, toolCalls: used.length, used, ms, offered: tools.map((t) => t.function.name).length, reply: reply.slice(0, 160), trace, offeredNames: tools.map((t) => t.function.name) };
    results.push(row);
    // RECORD=1: the result is evidence for the learned router (src/routing/learned-router.ts).
    const arm = ARMS.find((a) => a.model === `azure/${model}` || (model.includes(a.id) && !a.model.startsWith("azure/")));
    if (process.env.RECORD === "1" && arm && iters >= 0) {
        const cls = ["chain_settings", "calc_to_textedit", "newest_pdf", "playlist_and_tell", "switch_players", "textedit_type", "calculator_multistep", "find_open_file", "camera_permissions", "pdf_name_to_clipboard", "zip_folder"].includes(task.id) ? "desktop" : task.id.startsWith("browser_") ? "browser" : "quick";
        recordOutcome(cls, arm.id, { success: ok ? 1 : 0, failure: ok ? 0 : 1, calls: iters + 1, seconds: ms / 1000 });
    }
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    if (!ok) for (const t of trace) console.log("     · " + t);
    console.log(`${ok ? "✅" : "❌"} ${task.id.padEnd(22)} iters=${row.iters} calls=${used.length} ${ms}ms $${cost?.toFixed(5) ?? "?"} [${used.join(",")}] ${reply.slice(0, 80).replace(/\n/g, " ")}`);
    await sleep(500);
}
rmSync(EVAL_DIR, { recursive: true, force: true });
console.log(`SCORE ${MODEL}: ${results.filter((r) => r.ok).length}/${results.length}`);
process.exit(0);
