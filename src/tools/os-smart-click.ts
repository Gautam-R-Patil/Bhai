// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * os_smart_click (Phase 4/5) — the agent-facing entry point for the perception cascade.
 *
 * Takes a natural-language instruction + optional screenshot, runs the cascade
 * (AX → OmniParser → UI-TARS), executes the click, and records the outcome to
 * click-memory + drift-calibration for future fast-path recall.
 *
 * The agent should prefer this over the individual os_click / os_inspect / os_ground
 * tools for "click X" tasks — it's the single best path because it picks the right
 * tier automatically based on capability + AX availability.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { type LLMClient, MODELS } from "../llm.js";
import { axPerformAction, dumpAccessibilityTree } from "../screen/ax-dump.js";
import { recallClickSite, recordClickMiss, recordClickSuccess } from "../screen/click-memory.js";
import { applyCalibration, recordCalibrationSample } from "../screen/drift-calibration.js";
import { frontmostMatches, getFrontmostApp, pidOfApp, waitForFrontmost } from "../screen/frontmost.js";
import { type ClickOutcome, type classifyOutcome, classifyOutcomeFromImages } from "../screen/outcome-classifier.js";
import {
    type CascadeMiss,
    type CascadeTier,
    type ClickTarget,
    findClickTarget,
    formatCascadeResult,
} from "../screen/perception-router.js";
import {
    captureRegion,
    getScreenDimensions,
    isFallbackDims,
    type Rect,
    type ScreenDimensions,
} from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";
import { executeStructuredAction } from "./os-computer-action.js";
import { getActiveWindow, takeScreenshot } from "./platform-bridge.js";

// LLM client for the cloud_grounding cascade tier (Lite/Standard + degraded
// Full). Injected at boot via setSmartClickLLM(); null = cloud tier skipped.
let _smartClickLLM: LLMClient | null = null;
export function setSmartClickLLM(client: LLMClient): void {
    _smartClickLLM = client;
}

/** Click memory is relative to the focused window (else the monitor), so it survives the window moving. */
function clickBasis(
    d: ScreenDimensions,
    at?: { x: number; y: number },
): { x: number; y: number; w: number; h: number } {
    const fw = d.focusedWindow;
    const inWindow =
        fw &&
        fw.w > 0 &&
        fw.h > 0 &&
        (!at || (at.x >= fw.x && at.x < fw.x + fw.w && at.y >= fw.y && at.y < fw.y + fw.h));
    // A menu-bar item or a sheet outside the window is remembered against the monitor.
    return inWindow ? { x: fw.x, y: fw.y, w: fw.w, h: fw.h } : { x: d.originX, y: d.originY, w: d.width, h: d.height };
}

function recordClick(
    site: { app: string; windowTitle: string; elementLabel: string },
    x: number,
    y: number,
    d: ScreenDimensions,
): void {
    const b = clickBasis(d, { x, y });
    recordClickSuccess(site, x - b.x, y - b.y, b.w, b.h);
}

async function base64ToTempFile(base64: string, ext = "png"): Promise<string> {
    // crypto.randomBytes is unpredictable — defends against tmpdir symlink attacks
    // where an attacker pre-creates a known filename to capture the screenshot.
    const tmp = join(tmpdir(), `bhai_smartclick_${randomBytes(8).toString("hex")}.${ext}`);
    const buf = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    await fs.writeFile(tmp, buf, { mode: 0o600 });
    return tmp;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Extra wait before a click that changed nothing at 300ms is judged a no-op (and retried). */
export const SLOW_UI_MS = 1200;

/**
 * Raise an app to the foreground before grounding, so the AX dump and the
 * screenshot see the intended window and not whatever stole focus.
 *   "already" — it was frontmost; "raised" — it is now (callers re-read the
 *   focused-window rect); "failed" — it never came to the front (a click now
 *   would land in another app).
 *   macOS: `open -a` (safe — `tell…activate` can resolve the wrong binary), then
 *   poll until it is frontmost (fast on a warm app, patient on a cold launch).
 *   Windows: PowerShell AppActivate by window title, then by process. Linux: wmctrl by
 *   title, then by WM_CLASS. Off macOS only a definite "no such window" fails; whatever
 *   can't see windows (Wayland, no wmctrl/xdotool, a timeout) stays best-effort.
 */
const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]);

/** AXPress an element of a background app without raising it; null when that can't be done. */
async function pressInBackground(appName: string, instruction: string): Promise<Record<string, unknown> | null> {
    const pid = await pidOfApp(appName);
    if (!pid) return null;
    const dump = await dumpAccessibilityTree({ pid, depth: 20 }).catch(() => null);
    if (!dump || dump.error) return null;
    const target = await findClickTarget(instruction, {
        axDumpHint: dump,
        skipTiers: ["memory", "omniparser", "ui_tars", "cloud_grounding"],
    }).catch(() => null);
    if (!target?.ax || TEXT_ROLES.has(target.ax.role ?? "")) return null;
    const pressed = await axPerformAction(pid, target.ax, "press");
    if (!pressed.ok) return null;
    return {
        source: target.source,
        confidence: target.confidence,
        background: true,
        clicked_element: target.matchedLabel,
        note: `Pressed "${target.matchedLabel}" in ${appName} without bringing it to the front. To type into ${appName}, bring it forward with app_manager first.`,
    };
}

// Process / window-class names an app goes by when its name isn't one ("File Explorer" is explorer.exe).
const APP_ALIASES: Record<string, string[]> = {
    "file explorer": ["explorer"],
    "windows explorer": ["explorer"],
    "control panel": ["explorer"],
    files: ["explorer", "nautilus", "dolphin", "thunar", "nemo", "org.gnome.nautilus"],
    terminal: ["windowsterminal", "gnome-terminal", "konsole", "xfce4-terminal", "kgx", "ptyxis", "xterm"],
    "windows terminal": ["windowsterminal"],
    "google chrome": ["chrome"],
    "microsoft edge": ["msedge"],
    "visual studio code": ["code"],
    "microsoft word": ["winword"],
    "microsoft excel": ["excel"],
};
const appKey = (s: string) =>
    s
        .trim()
        .toLowerCase()
        .replace(/\.(exe|desktop)$/, "");

/**
 * Linux: what installed apps called `app` (Name/GenericName in any locale, desktop id or binary)
 * go by: desktop id, Exec binary and StartupWMClass. "Text Editor" → org.gnome.texteditor,
 * gnome-text-editor (and xed, gedit… where installed).
 */
async function desktopEntryNames(app: string): Promise<string[]> {
    const want = appKey(app);
    const dataDirs = [
        process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
        ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    ];
    const out = new Set<string>();
    for (const d of dataDirs) {
        const dir = join(d, "applications");
        for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
            if (!f.endsWith(".desktop")) continue;
            // The [Desktop Entry] group only: its actions have Names of their own.
            const entry = (await fs.readFile(join(dir, f), "utf8").catch(() => "")).split(/^\[Desktop Action/m)[0];
            const field = (k: string) => entry.match(new RegExp(`^${k}\\s*=\\s*(.*)$`, "m"))?.[1].trim() ?? "";
            const id = appKey(f);
            const bin = field("Exec")
                .split(/\s+/)
                .map((t) => t.replace(/["']/g, ""))
                .find((t) => t && t !== "env" && !t.includes("="))
                ?.split("/")
                .pop()
                ?.toLowerCase();
            const names = [...entry.matchAll(/^(?:Generic)?Name(?:\[[^\]]*\])?\s*=\s*(.*)$/gm)].map((m) =>
                appKey(m[1]),
            );
            if (![...names, id, id.split(".").pop(), bin].includes(want)) continue;
            // A launcher (flatpak run …, sh -c …) says nothing about the window.
            const exe = bin && !/^(flatpak|snap|sh|bash)$/.test(bin) ? bin : "";
            for (const n of [id, exe, field("StartupWMClass").toLowerCase()]) if (n.length > 2) out.add(n);
        }
    }
    return [...out];
}

/**
 * Linux: is the front app a kind of the asked name? Its own .desktop entry (Exec binary = the
 * front process, comm cut at 15) says so in Name/GenericName/Categories/Keywords: kitty is a
 * "Terminal emulator", xed is a TextEditor. "Terminal" with kitty in front, while GNOME's
 * Terminal is the one installed under that name, means kitty.
 */
async function frontIsKindOf(app: string, w: { app: string }): Promise<boolean> {
    const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const want = squash(app);
    const proc = appKey(w.app);
    if (want.length < 3 || !proc) return false;
    const dataDirs = [
        process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
        ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    ];
    for (const d of dataDirs) {
        const dir = join(d, "applications");
        for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
            if (!f.endsWith(".desktop")) continue;
            const entry = (await fs.readFile(join(dir, f), "utf8").catch(() => "")).split(/^\[Desktop Action/m)[0];
            const bin = (entry.match(/^Exec\s*=\s*(.*)$/m)?.[1] ?? "")
                .split(/\s+/)
                .map((t) => t.replace(/["']/g, ""))
                .find((t) => t && t !== "env" && !t.includes("="))
                ?.split("/")
                .pop()
                ?.toLowerCase();
            if (!bin || !(bin === proc || (proc.length >= 15 && bin.startsWith(proc)))) continue;
            const kinds = [...entry.matchAll(/^(?:Generic)?Name(?:\[[^\]]*\])?\s*=\s*(.*)$|^(?:Categories|Keywords)(?:\[[^\]]*\])?\s*=\s*(.*)$/gm)]
                .flatMap((m) => (m[1] ?? m[2] ?? "").split(/[;,]/))
                .map(squash);
            if (kinds.some((k) => k.includes(want))) return true;
        }
    }
    return false;
}

/** Is the active window (process name + title, off macOS) one of these app names? */
export function activeWindowIsApp(names: string[], w: { app: string; title: string }): boolean {
    const proc = appKey(w.app);
    const title = w.title.trim().toLowerCase();
    // ps cuts comm to 15 chars ("gnome-text-edit"); "gnome-terminal-" is gnome-terminal-server.
    return names.some(
        (n) =>
            !!n &&
            ((!!proc && proc !== "unknown" && (proc === n || proc === n.slice(0, 15) || proc.startsWith(`${n}-`))) ||
                title === n ||
                title.endsWith(` - ${n}`) ||
                title.endsWith(` — ${n}`)),
    );
}

// What the active-window helper says when it can't tell which app is in front: no xdotool (unknown),
// its own PowerShell, or the frame host every UWP app (Calculator, Settings) shares.
const frontUnknown = (w: { app: string }) => /^(unknown|powershell|applicationframehost)$/i.test(w.app.trim());

async function activateApp(appName: string): Promise<"already" | "raised" | "failed"> {
    if (!appName || appName === "unknown") return "already";
    try {
        if (process.platform === "darwin") {
            const front = await getFrontmostApp();
            if (front && frontmostMatches(appName, front)) return "already";
            // System agents are never frontmost: nothing to raise.
            // ponytail: fixed list; third-party menu-bar-only apps still wait out the 5s.
            if (/^(dock|control ?center|systemuiserver|notification ?center)$/i.test(appName.trim())) return "already";
            try {
                await execFileAsync("open", ["-a", appName], { timeout: 4000 });
            } catch {
                // A loose name `open -a` can't resolve ("Chrome"): best-effort, click in what's in front.
                return "already";
            }
            return (await waitForFrontmost(appName, 5000)) ? "raised" : "failed";
        }
        // Off macOS, activating by the name alone (as before) and a miss proves little: the app may be
        // in front under a title or process that doesn't name it ("Downloads" is File Explorer,
        // "Untitled Document 1" is Text Editor). On a miss: what the window system can't tell stays
        // best-effort, the app in front is clicked without raising another of its windows, and only
        // an app we can name that has no window anywhere fails (a click would land in another app).
        const aliases = APP_ALIASES[appKey(appName)] ?? [];
        if (process.platform === "win32") {
            const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
            const run = async (script: string) =>
                (
                    await execFileAsync(
                        "powershell",
                        ["-NoProfile", "-Command", `$ws = New-Object -ComObject WScript.Shell; ${script}`],
                        { timeout: 5000 },
                    )
                ).stdout.trim();
            // VBScript-free: WScript.Shell AppActivate via PowerShell; False = no window has that title.
            if ((await run(`$ws.AppActivate(${ps(appName)})`)) === "False") {
                const w = await getActiveWindow();
                const names = [appKey(appName), ...aliases];
                if (frontUnknown(w) || activeWindowIsApp(names, w)) return "already";
                // The exe the name launches (PATH, App Paths, a Start Menu shortcut: "Adobe Acrobat" →
                // Acrobat, "OBS Studio" → obs64) joins the process names; the script prints each name
                // that is a real app, then True once one of its windows is activated. (No double quotes:
                // they don't survive the command line intact.)
                const sm = (env: string) => `(Join-Path $env:${env} 'Microsoft\\Windows\\Start Menu\\Programs')`;
                const out = await run(
                    `$app = ${ps(appName.trim())}; $names = @(${names.map(ps).join(",")}); $exes = @(); ` +
                        `if (-not [WildcardPattern]::ContainsWildcardCharacters($app)) { ` +
                        `$c = Get-Command ($app + '.exe') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $exes += $c.Source }; ` +
                        `foreach ($k in 'HKCU:','HKLM:') { $v = (Get-ItemProperty -LiteralPath ($k + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + $app + '.exe') -ErrorAction SilentlyContinue).'(default)'; if ($v) { $exes += $v } } }; ` +
                        `Get-ChildItem ${sm("ProgramData")},${sm("APPDATA")} -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ` +
                        `Where-Object { $_.BaseName -eq $app } | ForEach-Object { $t = $ws.CreateShortcut($_.FullName).TargetPath; if ($t) { $exes += $t } }; ` +
                        `$en = @($exes | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Trim([char]34)) }); $en; $names += $en; ` +
                        `$procs = Get-Process; foreach ($n in ($names | Select-Object -Unique)) { ` +
                        `$all = @($procs | Where-Object { $_.ProcessName -eq $n }); if ($all.Count) { $n }; ` +
                        `$p = $all | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
                        `if ($p -and $ws.AppActivate($p.Id)) { 'True'; exit } }`,
                );
                const lines = out
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean);
                if (!lines.includes("True")) {
                    // A name nothing on this PC answers to ("VS Code" for Code) may still mean the
                    // front app: best-effort, as before. Only a real app that isn't in front fails.
                    // Aliases count only when the script found them (a cmd console in front, "Terminal"
                    // asked, no Windows Terminal running, is clicked).
                    const known = lines.map(appKey);
                    return !known.length || activeWindowIsApp(known, w) ? "already" : "failed";
                }
            }
        } else {
            // found / none (exit 1: no such window) / unknown (no wmctrl, a timeout).
            const wmctrl = (args: string[]) =>
                execFileAsync("wmctrl", args, { timeout: 4000 }).then(
                    () => "found",
                    (err) => ((err as { code?: unknown }).code === 1 ? "none" : "unknown"),
                );
            // wmctrl can't see native Wayland windows: a miss there proves nothing.
            const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland";
            if ((await wmctrl(["-a", appName])) === "none" && !wayland) {
                const w = await getActiveWindow();
                if (frontUnknown(w)) return "already";
                // Aliases help match and look up windows but don't make the name an installed app:
                // kitty in front with "Terminal" asked, and no app named Terminal, is clicked.
                const known = await desktopEntryNames(appName);
                const names = [...new Set([appKey(appName), ...aliases, ...known])];
                if (activeWindowIsApp(names, w)) return "already";
                let r = "none";
                for (const n of names) {
                    r = await wmctrl(["-x", "-a", n]); // by WM_CLASS
                    if (r !== "none") break;
                }
                if (r === "unknown") return "already";
                // A name no installed app answers to ("Notepad" here) may still mean the front app.
                // A kind of app ("Terminal") with another of its kind in front (kitty) means that one.
                if (r === "none") return known.length && !(await frontIsKindOf(appName, w)) ? "failed" : "already";
            }
        }
        await sleep(350); // no frontmost probe here: let the window raise
        return "raised";
    } catch {
        return process.platform === "darwin" ? "failed" : "already"; /* best-effort off macOS */
    }
}

/** Window-scoped capture (kill-switch BHAI_NO_WINDOW_SCOPED_CAPTURE forces full-screen). */
async function captureWindowRegion(fw: Rect): Promise<Buffer | null> {
    if (process.env.BHAI_NO_WINDOW_SCOPED_CAPTURE === "true") return null;
    return captureRegion(fw);
}

const VISION_TIERS = new Set<CascadeTier>(["omniparser", "ui_tars", "cloud_grounding"]);

/** "Google Chrome" for a pid, for messages; the pid itself if ps can't say. */
async function appNameOfPid(pid: number): Promise<string> {
    try {
        const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], { timeout: 2000 });
        const comm = stdout.trim();
        return /\/([^/]+)\.app\//.exec(comm)?.[1] || comm.split("/").pop() || `pid ${pid}`;
    } catch {
        return `pid ${pid}`;
    }
}

function missTip(m?: CascadeMiss): string {
    switch (m?.reason) {
        case "ax_permission_missing":
            return "Accessibility permission is missing, so no on-screen element could be read (this is not a bad label). Ask the user to grant Bhai Accessibility in System Settings → Privacy & Security → Accessibility.";
        case "ambiguous":
            return "Several elements match equally (see `ambiguous`). Re-issue with the one you mean: quote its exact label, mention nearby text, or add top/bottom/left/right.";
        case "ax_partial":
            return "The app stopped answering mid-read, so its accessibility tree was incomplete and was not matched (`nearest` is empty for that reason). Retry in a moment, or call os_screenshot to reason about the layout.";
        case "disabled":
            return "The matching element is disabled — do whatever enables it first, then retry.";
        default:
            return "No grounding tier located the element. `nearest` lists the closest accessibility labels and `tier_errors` why the vision tiers failed. Call os_inspect to see the elements that ARE visible, or os_screenshot to reason about the layout before retrying.";
    }
}

export const osSmartClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_smart_click",
            description:
                "DEFAULT click-by-description tool — ALWAYS try this FIRST for any 'click <description>' task on the host OS. It cascades automatically: persistent click-memory → Accessibility tree (fast, no screenshot needed) → OmniParser vision → UI-TARS local grounding. One tool call replaces os_scan+os_click_element / os_ocr_click flows. Pass `instruction` in plain English (e.g. 'the Save button in the toolbar', 'Wi-Fi in System Settings'). You do NOT need to pass a screenshot — the tool activates the target app and captures a FRESH frame itself; do NOT pass an old `screenshot_base64` (stale pixels cause misclicks). Records every successful click for future fast-path recall (sub-10ms on repeat). Use os_ocr_click / os_scan only as fallback when this returns cascade_miss.",
            parameters: {
                type: "object",
                properties: {
                    instruction: {
                        type: "string",
                        description:
                            'Natural-language description of what to click (e.g. "the Save button in the top-right toolbar").',
                    },
                    screenshot_base64: {
                        type: "string",
                        description:
                            "Optional last-resort base64 screenshot. Normally OMIT this — the tool auto-captures a fresh window-scoped frame at click time. Only pass one if you cannot let the tool capture (rare); a stale frame will cause misclicks.",
                    },
                    surface_hint: {
                        type: "string",
                        enum: ["native", "canvas", "web"],
                        description:
                            'Optional hint: "native" (default, prefer AX), "canvas" (Figma/Photoshop — skip AX), "web" (try AX first, fall through to vision).',
                    },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click"],
                        description: "Click action (default: click).",
                    },
                    app: {
                        type: "string",
                        description:
                            "Optional app name for click-memory keying. Auto-detected from frontmost if not supplied.",
                    },
                    window_title: {
                        type: "string",
                        description:
                            "Optional window-title context for click-memory keying. Helps disambiguate same-app same-label in different windows.",
                    },
                },
                required: ["instruction"],
            },
        },
    },

    async handler(input) {
        // Past this, never click: the tool layer gives up at 45s (index.ts) and a
        // late click would land after the agent has moved on (double "Send").
        const deadline = Date.now() + 40_000;
        const instruction = input.instruction as string;
        const action = (input.action as "click" | "double_click" | "right_click") || "click";
        const surface = input.surface_hint as "native" | "canvas" | "web" | undefined;
        let appName = (input.app as string) || "";
        let windowTitle = (input.window_title as string) || "";
        if (!instruction) return JSON.stringify({ success: false, error: "instruction required" });

        let dims = await getScreenDimensions({ focusedWindow: true });
        let dimsAreFallback = isFallbackDims(dims);

        // Auto-detect app when caller didn't specify — keying click memory by
        // `unknown` collapses every site into a single bucket and defeats the cache.
        // AxDump doesn't currently expose a window title, so window_title falls
        // back to the app name (still per-app, which is better than per-process).
        // Full-depth (20, same as the router's own) so the cascade reuses this
        // dump as its AX hint instead of dumping a second time.
        let axDumpHint: Awaited<ReturnType<typeof dumpAccessibilityTree>> | undefined;
        let appIsFrontmost = false;
        if (!appName) {
            try {
                const dump = await dumpAccessibilityTree({ depth: 20 });
                if (dump && !dump.error) {
                    axDumpHint = dump;
                    appName = dump.app || "";
                    appIsFrontmost = !!appName;
                }
            } catch {
                /* AX unavailable — fall back to placeholders */
            }
        }
        if (!windowTitle) windowTitle = appName;
        if (!appName) appName = "unknown";
        if (!windowTitle) windowTitle = "default";

        // In the background first (from trycua/cua's driver): a button, checkbox or menu item
        // of an app that isn't in front is pressed through accessibility on that app's
        // process, so the owner's front window keeps the focus. Text fields still come to
        // the front (typing follows), and a miss falls through to the path below.
        if (
            !appIsFrontmost &&
            action === "click" &&
            appName &&
            !/^dock$/i.test(appName.trim()) && // the Dock has its own search (dockFirst) and is never in front
            process.env.BHAI_NO_BACKGROUND_PRESS !== "true"
        ) {
            const done = await pressInBackground(appName, instruction);
            if (done) return JSON.stringify({ success: true, instruction, ...done });
        }

        // The AX dump, the screenshot and any remembered spot all belong to the
        // target app's window: bring it to the front first (a no-op when it is).
        if (!appIsFrontmost) {
            const raised = await activateApp(appName);
            if (raised === "failed") {
                return JSON.stringify({
                    success: false,
                    error: `could not bring "${appName}" to the front (nothing was clicked). Check the app name, or open it with app_manager first.`,
                });
            }
            if (raised === "raised") {
                dims = await getScreenDimensions({ focusedWindow: true, force: true });
                dimsAreFallback = isFallbackDims(dims);
            }
        }

        const site = { app: appName, windowTitle, elementLabel: instruction };
        const verifyOn = process.env.BHAI_NO_SMARTCLICK_VERIFY !== "true";
        const selfCorrectOn = process.env.BHAI_NO_SMARTCLICK_SELFCORRECT !== "true";

        // A frame of the region the click is judged in: the focused window when
        // its rect is known and holds `at`, else the monitor (a menu-bar click).
        // Returns the rect it shows.
        const snap = async (at?: { x: number; y: number }): Promise<{ buf: Buffer; rect: Rect } | null> => {
            const r = dimsAreFallback ? dims.focusedWindow : clickBasis(dims, at);
            if (r && r.w > 0 && r.h > 0) {
                const buf = await captureWindowRegion(r);
                if (buf) return { buf, rect: r };
            }
            try {
                return { buf: await takeScreenshot(), rect: { x: 0, y: 0, w: dims.width, h: dims.height } };
            } catch {
                return null;
            }
        };

        // Click at (x, y) and classify what changed. The pointer moves there first
        // and the "before" frame is taken after any hover highlight has drawn, so
        // a highlight alone can't pass for the click working.
        const clickAndVerify = async (
            x: number,
            y: number,
        ): Promise<{ dispatchErr?: string; verdict?: ClickOutcome }> => {
            if (!verifyOn) {
                const r = await dispatchClick(action, x, y, dims);
                return r.success ? {} : { dispatchErr: r.error || "click_dispatch_failed" };
            }
            await dispatchClick("mouse_move", x, y, dims);
            await sleep(80);
            const before = await snap({ x, y });
            const r = await dispatchClick(action, x, y, dims);
            if (!r.success) return { dispatchErr: r.error || "click_dispatch_failed" };
            await sleep(300); // let the UI settle
            let after = await snap({ x, y });
            const rect = before?.rect ?? after?.rect ?? { x: 0, y: 0, w: dims.width, h: dims.height };
            const judge = () =>
                classifyOutcomeFromImages(
                    before?.buf ?? null,
                    after?.buf ?? null,
                    x - rect.x,
                    y - rect.y,
                    rect.w,
                    rect.h,
                );
            let outcome = await judge();
            // A slow UI (a network round-trip, an app launching) shows nothing at 300ms, and a
            // no-op gets clicked again — a second Send. Look once more before calling it one.
            if (outcome.outcome === "no_op") {
                await sleep(SLOW_UI_MS);
                after = (await snap({ x, y })) ?? after;
                outcome = await judge();
            }
            const verdict = await reportClickOutcome(
                site,
                { x, y },
                before?.buf ?? null,
                after?.buf ?? null,
                rect.w,
                rect.h,
                { origin: { x: rect.x, y: rect.y }, outcome },
            );
            return { verdict: verdict.outcome };
        };

        // Step 0 — click-memory recall (Phase 5 tier 0 — bypasses the cascade entirely on hit).
        try {
            // Threshold mirrors DEFAULT_THRESHOLDS.memory in perception-router so the
            // tier-0 stub and the smart-click fast-path treat memory hits identically.
            const recall = recallClickSite(site);
            // Rows are relative to the window, or to the monitor for points outside
            // it (menu bar): use whichever size the row was saved with. A resized
            // window matches neither, so it re-grounds instead.
            const win = clickBasis(dims);
            const mon = { x: dims.originX, y: dims.originY, w: dims.width, h: dims.height };
            const box = [win, mon].find((b) => recall?.lastScreenWidth === b.w && recall?.lastScreenHeight === b.h);
            if (recall && recall.confidence >= 0.9 && box) {
                let x = Math.round(recall.xNorm * box.w + box.x);
                let y = Math.round(recall.yNorm * box.h + box.y);
                // Apply drift calibration if learned for this monitor.
                ({ x, y } = applyCalibration(dims.monitorId, x, y));
                // A remembered spot is replayed blind, so it's checked like a
                // vision click: a miss (recorded by reportClickOutcome) erodes the
                // row until it is dropped, instead of replaying for 90 days.
                const r = await clickAndVerify(x, y);
                if (r.dispatchErr)
                    return JSON.stringify({ success: false, source: "memory", error: r.dispatchErr, instruction });
                if (r.verdict === "wrong_target") {
                    return JSON.stringify({
                        success: false,
                        error: "click_unverified",
                        source: "memory",
                        instruction,
                        clicked: { x, y },
                        verified: r.verdict,
                        tip: "A remembered click position changed something away from the target, so it was dropped from click memory. Take an os_screenshot to see what happened before retrying.",
                    });
                }
                // no_op: nothing happened, so it's safe to re-ground and click fresh below.
                if (r.verdict !== "no_op") {
                    if (r.verdict === "success" && !dimsAreFallback) {
                        try {
                            recordClick(site, x, y, dims);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    return JSON.stringify({
                        success: true,
                        source: "memory",
                        confidence: recall.confidence,
                        instruction,
                        clicked: { x, y },
                        verified: r.verdict ?? "not_checked",
                        success_count: recall.successCount,
                        elapsed_ms: 0,
                        tip: `Click memory hit (${recall.successCount} prior successes). To force a fresh probe, pass a different instruction or use os_inspect directly.`,
                    });
                }
            }
        } catch (e) {
            // Memory subsystem failed (DB unavailable) — non-fatal; fall through to cascade.
            console.warn(`[smart-click] memory recall failed: ${(e as Error).message}`);
        }

        // Step 1 — run the perception cascade.
        let tempPath: string | null = null;
        // Dims the cascade scales vision-tier coords against: the window when we
        // region-capture, else the monitor.
        let cascadeDims = dims;
        try {
            // The screenshot is only needed by the vision tiers, so it's taken
            // lazily — an AX hit never pays for it. It is always a FRESH frame:
            // agents routinely pass a STALE screenshot_base64 (pixels from before
            // the UI changed) → wrong_target / cascade_miss (observed live). The
            // caller's base64 is used ONLY as a last resort when fresh capture
            // fails, or when BHAI_SMARTCLICK_USE_CALLER_SCREENSHOT=true restores
            // the old "trust caller pixels" behavior.
            const preferCaller = process.env.BHAI_SMARTCLICK_USE_CALLER_SCREENSHOT === "true";
            const captureShot = async (): Promise<{ path: string; dims: ScreenDimensions } | null> => {
                if (tempPath) return { path: tempPath, dims: cascadeDims };
                if (preferCaller && input.screenshot_base64) {
                    tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                    return { path: tempPath, dims };
                }
                // Prefer a WINDOW-SCOPED capture: a full-screen image lets a stray
                // background window pollute grounding. The cascade gets WINDOW
                // dims (origin = window x/y, size = window w/h) so model coords map
                // back to absolute screen coords with the shared scaling math.
                const fw = dims.focusedWindow;
                let buf: Buffer | null = null;
                if (fw && fw.w > 0 && fw.h > 0) {
                    buf = await captureWindowRegion(fw);
                    if (buf) cascadeDims = { ...dims, originX: fw.x, originY: fw.y, width: fw.w, height: fw.h };
                }
                if (!buf) {
                    try {
                        buf = await takeScreenshot();
                    } catch (capErr) {
                        console.warn(`[smart-click] auto-screenshot failed: ${(capErr as Error).message}`);
                    }
                }
                if (buf) {
                    tempPath = join(tmpdir(), `bhai_smartclick_${randomBytes(6).toString("hex")}.png`);
                    await fs.writeFile(tempPath, buf, { mode: 0o600 });
                    return { path: tempPath, dims: cascadeDims };
                }
                // Last resort: fresh capture failed AND the caller gave us a frame.
                if (input.screenshot_base64) {
                    tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                    return { path: tempPath, dims };
                }
                return null;
            };

            const skipTiers: CascadeTier[] = [];
            if (surface === "canvas") skipTiers.push("ax_exact", "ax_fuzzy");

            // Ground → click → (vision only) verify. Returns a structured result.
            // `extraSkip` lets the self-correction force descent past a failed tier.
            const attempt = async (
                extraSkip: CascadeTier[],
                groundingModel?: string,
            ): Promise<{
                ok: boolean;
                target: ClickTarget | null;
                calX: number;
                calY: number;
                verdict?: string;
                dispatchErr?: string;
                miss?: CascadeMiss;
            }> => {
                let miss: CascadeMiss | undefined;
                const target = await findClickTarget(instruction, {
                    screenshot: captureShot,
                    skipTiers: [...skipTiers, ...extraSkip],
                    screenDims: dims,
                    axDumpHint,
                    dockFirst: /^dock$/i.test(appName.trim()),
                    llm: _smartClickLLM ?? undefined,
                    groundingModel,
                    groundingTimeoutMs: Math.max(3000, deadline - Date.now() - 5000),
                    onMiss: (m) => {
                        miss = m;
                    },
                });
                if (!target) return { ok: false, target: null, calX: 0, calY: 0, miss };
                if (Date.now() > deadline) {
                    return {
                        ok: false,
                        target,
                        calX: 0,
                        calY: 0,
                        dispatchErr: "timed_out_before_click (nothing was clicked)",
                    };
                }

                // AX hit: press the element itself when it supports AXPress (no
                // pixels, works under overlaps); an off-screen one is scrolled
                // into view first — never clicked at a clamped monitor edge.
                if (target.ax) {
                    if (action === "click") {
                        const pressed = await axPerformAction(target.ax.pid, target.ax, "press");
                        if (pressed.ok) {
                            if (!dimsAreFallback && !target.ax.offscreen) {
                                try {
                                    recordClick(site, target.x, target.y, dims);
                                } catch {
                                    /* non-fatal */
                                }
                            }
                            return { ok: true, target, calX: target.x, calY: target.y, verdict: "ax_press" };
                        }
                        // The press may have run (a menu/modal handler blocks AXPress
                        // past its timeout): a pixel click now would run it twice.
                        if (pressed.unconfirmed) {
                            return {
                                ok: false,
                                target,
                                calX: target.x,
                                calY: target.y,
                                dispatchErr: `ax_press_unconfirmed: AXPress on "${target.matchedLabel}" did not report back (${pressed.error}); it may have worked. Take an os_screenshot before retrying; nothing else was clicked.`,
                            };
                        }
                    }
                    if (target.ax.offscreen) {
                        const shown = await axPerformAction(target.ax.pid, target.ax, "reveal");
                        if (!shown.ok || !shown.frame) {
                            return {
                                ok: false,
                                target,
                                calX: target.x,
                                calY: target.y,
                                dispatchErr: `element_offscreen: "${target.matchedLabel}" is scrolled out of view and could not be revealed (${shown.error}). Scroll it into view first; nothing was clicked.`,
                            };
                        }
                        target.x = shown.frame.x + Math.floor(shown.frame.w / 2);
                        target.y = shown.frame.y + Math.floor(shown.frame.h / 2);
                    }
                    // A pixel click lands on whatever is on top there: raise the element's
                    // own window first (another window of the same app, or another app's,
                    // may be over it), then make sure it is what's under the point.
                    const focused = await axPerformAction(target.ax.pid, target.ax, "focus");
                    if (focused.ok && focused.frame) {
                        target.x = focused.frame.x + Math.floor(focused.frame.w / 2);
                        target.y = focused.frame.y + Math.floor(focused.frame.h / 2);
                        const hit = focused.hitPid ?? 0;
                        // Bhai's own windows (overlay, panel) step aside for its clicks.
                        if (hit && hit !== target.ax.pid && hit !== process.pid && hit !== process.ppid) {
                            const cover = await appNameOfPid(hit);
                            return {
                                ok: false,
                                target,
                                calX: target.x,
                                calY: target.y,
                                dispatchErr: `element_covered: "${target.matchedLabel}" is under a window of ${cover} that stays on top even after raising its own window. Move or close that window (or ask the owner to), then retry; nothing was clicked.`,
                            };
                        }
                    }
                }

                const { x: calX, y: calY } = applyCalibration(dims.monitorId, target.x, target.y);

                // Vision tiers can return wrong coordinates (the model mis-grounds);
                // AX geometry is trusted. Only vision-tier clicks are verified.
                if (!VISION_TIERS.has(target.source) || !verifyOn) {
                    const r = await dispatchClick(action, calX, calY, dims);
                    if (!r.success)
                        return { ok: false, target, calX, calY, dispatchErr: r.error || "click_dispatch_failed" };
                    if (!dimsAreFallback) {
                        try {
                            recordClick(site, calX, calY, dims);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    return { ok: true, target, calX, calY };
                }

                const r = await clickAndVerify(calX, calY);
                if (r.dispatchErr) return { ok: false, target, calX, calY, dispatchErr: r.dispatchErr };
                if (r.verdict === "success" || r.verdict === "modal_pop") {
                    if (!dimsAreFallback) {
                        try {
                            recordClick(site, calX, calY, dims);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    return { ok: true, target, calX, calY, verdict: r.verdict };
                }
                if (r.verdict === "unknown") {
                    // Ambiguous — don't poison memory either way; soft-pass.
                    return { ok: true, target, calX, calY, verdict: "unknown" };
                }
                // no_op / wrong_target — reportClickOutcome already recorded a miss.
                return { ok: false, target, calX, calY, verdict: r.verdict };
            };

            let res = await attempt([]);

            // Self-correction: a vision click that verified as a miss → re-ground
            // forcing descent past the failed tier (+ all above it), click once more.
            if (
                !res.ok &&
                res.target &&
                selfCorrectOn &&
                VISION_TIERS.has(res.target.source) &&
                verifyOn &&
                !res.dispatchErr
            ) {
                const order: CascadeTier[] = [
                    "memory",
                    "ax_exact",
                    "ax_fuzzy",
                    "omniparser",
                    "ui_tars",
                    "cloud_grounding",
                ];
                const failedIdx = order.indexOf(res.target.source);
                // A Haiku grounding miss gets one Sonnet re-ground; any other
                // vision miss descends past the failed tier.
                // Only after a true no-op: a "wrong_target" click did something, and
                // clicking again could repeat it (a second Send, a second keypress).
                const regroundWithSonnet = res.target.source === "cloud_grounding" && res.verdict === "no_op";
                const forceSkip = order.slice(0, regroundWithSonnet ? failedIdx : failedIdx + 1);
                const first = { x: res.calX, y: res.calY };
                // Re-ground on the screen as it is now, not the pre-click frame.
                if (tempPath) {
                    const fresh = await snap();
                    if (fresh) await fs.writeFile(tempPath, fresh.buf, { mode: 0o600 }).catch(() => {});
                }
                const retry =
                    deadline - Date.now() > 8000 && (regroundWithSonnet || res.target.source !== "cloud_grounding")
                        ? await attempt(forceSkip, regroundWithSonnet ? MODELS.SONNET : undefined)
                        : { ok: false, target: null, calX: 0, calY: 0 };
                // Only accept a retry that grounded somewhere clearly different (≥20px).
                if (retry.target && Math.hypot(retry.calX - first.x, retry.calY - first.y) >= 20) res = retry;
            }

            if (res.dispatchErr) {
                return JSON.stringify({
                    success: false,
                    error: res.dispatchErr,
                    target: res.target,
                    formatted: formatCascadeResult(res.target),
                });
            }
            if (!res.ok && !res.target) {
                const m = res.miss;
                return JSON.stringify({
                    success: false,
                    error: "cascade_miss",
                    reason: m?.reason ?? "not_found",
                    instruction,
                    formatted: formatCascadeResult(null, m),
                    app: m?.app,
                    ax_element_count: m?.axElementCount,
                    ax_error: m?.axError,
                    nearest: m?.nearest,
                    ambiguous: m?.ambiguous,
                    tier_errors: m?.tierErrors,
                    // "Open TextEdit" isn't a click: weak models reach for this tool to launch apps.
                    tip: /^\s*(open|launch|start|switch to|go to)\s+(the\s+)?[\w .]+(app)?\s*$/i.test(instruction)
                        ? "To open or switch to an app, call app_manager with action='activate' and app='<name>' (it launches the app if needed). Then act inside it."
                        : missTip(m),
                });
            }
            if (!res.ok) {
                return JSON.stringify({
                    success: false,
                    error: "click_unverified",
                    instruction,
                    clicked: { x: res.calX, y: res.calY },
                    target: res.target,
                    verified: res.verdict,
                    formatted: formatCascadeResult(res.target),
                    tip: `Grounded via ${res.target?.source} and clicked, but post-click verification saw no expected change (${res.verdict}). The element may not have been where grounding predicted. Try os_inspect or os_screenshot to re-locate.`,
                });
            }
            return JSON.stringify({
                success: true,
                source: res.target?.source,
                confidence: res.target?.confidence,
                instruction,
                clicked: { x: res.calX, y: res.calY },
                target: res.target,
                verified:
                    res.verdict ?? (res.target && VISION_TIERS.has(res.target.source) ? undefined : "trusted_tier"),
                formatted: formatCascadeResult(res.target),
                tip: `Cascade succeeded via ${res.target?.source} (${res.target?.totalMs}ms). ${res.verdict ? `Verified: ${res.verdict}. ` : ""}Recorded to click memory.`,
            });
        } finally {
            if (tempPath) {
                try {
                    await fs.unlink(tempPath);
                } catch {
                    /* best-effort */
                }
            }
        }
    },
};

/** Dispatch through os_computer_action's executor with the dims we already have (no second probe). */
async function dispatchClick(
    action: "click" | "double_click" | "right_click" | "mouse_move",
    x: number,
    y: number,
    dims: ScreenDimensions,
): Promise<{ success: boolean; error?: string }> {
    try {
        await executeStructuredAction({ action, coord: [x, y], coordSystem: "screen" }, dims);
        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

/**
 * After-action telemetry helper. Caller passes before/after screenshots + target;
 * we update click-memory based on the classified outcome and optionally feed a
 * (predicted, actual) drift sample when the caller can locate the post-click element.
 *
 * `actual` should be the screen-pixel center of the element that visibly responded
 * to the click (typically a post-verify AX dump or OmniParser re-run after the
 * action). When omitted, no calibration sample is recorded — recording (predicted,
 * predicted) is circular and locks the transform.
 *
 * `target` is in absolute screen coords; `before`/`after` are encoded captures
 * of the imageWidth × imageHeight (logical px) region whose top-left is
 * `opts.origin` (default 0,0) — the target is made region-relative before diffing.
 */
export async function reportClickOutcome(
    site: { app: string; windowTitle: string; elementLabel: string },
    target: { x: number; y: number },
    before: Buffer | null,
    after: Buffer | null,
    imageWidth: number,
    imageHeight: number,
    opts?: {
        monitorId?: string;
        actual?: { x: number; y: number };
        origin?: { x: number; y: number };
        /** Already classified by the caller: only record it. */
        outcome?: ReturnType<typeof classifyOutcome>;
    },
): Promise<ReturnType<typeof classifyOutcome>> {
    const ox = opts?.origin?.x ?? 0;
    const oy = opts?.origin?.y ?? 0;
    const outcome =
        opts?.outcome ??
        (await classifyOutcomeFromImages(before, after, target.x - ox, target.y - oy, imageWidth, imageHeight));
    try {
        if (outcome.outcome === "no_op" || outcome.outcome === "wrong_target") {
            recordClickMiss(site);
        } else if (outcome.outcome === "success" && opts?.monitorId && opts.actual) {
            // Only record a calibration sample when we have a measured landing point.
            recordCalibrationSample(opts.monitorId, target, opts.actual);
        }
    } catch {
        /* memory persistence failed — non-fatal */
    }
    return outcome;
}
