// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The swarm's approval boundary. runSwarm opens a run context for the whole
// run and the mesh opens a step context around each step's sub-agent; every
// tool call made under them (sub-agents, speculation, A2A delegates, nested
// swarms, code_execute) inherits both through AsyncLocalStorage. executeTool
// asks swarmGate() before running a tool: inside a swarm, an EXTERNAL SIDE
// EFFECT runs only in a step the owner approved, either with the Telegram
// buttons or by saying yes after a run held that step back (swarm_task re-sent
// with confirmed: true, checked by security/consent.ts; that re-run resumes the
// held steps, see swarm.ts). Otherwise the call is not run, it is recorded in
// `blocked`, and the mesh reports the step as needing approval. No English
// step text is classified here. Outside a swarm this does nothing.
//
// ACCEPTED LIMIT: A swarm can still trigger an external effect through a web
// page or desktop UI (e.g. clicking Send in Gmail) or by writing and running
// its own script; the gate covers explicit external tools and shell launchers,
// matching the main agent's per-tool consent gate. The Telegram early ask
// covers plan steps that name such actions.

import { AsyncLocalStorage } from "node:async_hooks";
import { requiresConfirmation } from "../tools/tool-intelligence.js";

export interface SwarmRunContext {
    consentKey: string;
    /** checkConsent granted this run (the owner said yes after it was asked). */
    consentGranted: boolean;
    blocked: Array<{ step?: string; tool: string; summary: string }>;
    /**
     * A confirmed re-run resumes the steps the owner was told about: the grant
     * covers only these, once each (the mesh removes an id when its step runs,
     * and swarm.ts clears the rest after the resume wave). Unset (a swarm nested
     * in an approved step), the grant covers the whole run.
     */
    approvedSteps?: Set<string>;
}

export interface SwarmStepContext {
    stepId: string;
    stepApproved: boolean;
}

const runStore = new AsyncLocalStorage<SwarmRunContext>();
const stepStore = new AsyncLocalStorage<SwarmStepContext>();

export function withSwarmRun<T>(run: SwarmRunContext, fn: () => Promise<T>): Promise<T> {
    return runStore.run(run, fn);
}
export function withSwarmStep<T>(step: SwarmStepContext, fn: () => Promise<T>): Promise<T> {
    return stepStore.run(step, fn);
}
export const currentSwarmRun = (): SwarmRunContext | undefined => runStore.getStore();
/** Runs fn with no swarm run or step: work it starts in the background doesn't inherit the step's grant. */
export function outsideSwarm<T>(fn: () => Promise<T>): Promise<T> {
    return runStore.exit(() => stepStore.exit(fn));
}
export const currentSwarmStep = (): SwarmStepContext | undefined => stepStore.getStore();

/** The run's grant covers every step (a swarm nested in an approved step). */
export const runWideGrant = (run: SwarmRunContext | undefined): boolean => !!run?.consentGranted && !run.approvedSteps;

/**
 * A payment refused inside a swarm. Unlike a gate hold, it is never approved by a
 * confirmed swarm_task re-run: the main agent makes it itself after the owner's OK.
 */
/** Pays or places an order: the vault payment, or a site skill's checkout confirm. A swarm never does either. */
export const isPaymentCall = (name: string, args: Record<string, unknown>): boolean =>
    name === "vault_authorize_payment" || (name === "site_task" && args.action === "confirm");
/** A hold recorded for a payment call (site_task is only ever held at confirm). */
export const isPaymentHold = (b: { tool: string }): boolean =>
    b.tool === "vault_authorize_payment" || b.tool === "site_task";

/** Calls the gate has held back so far in the current step (0 outside a swarm). */
export function stepBlockCount(): number {
    const run = currentSwarmRun();
    const id = currentSwarmStep()?.stepId;
    return run ? run.blocked.filter((b) => b.step === id).length : 0;
}

/** Consent key for a swarm run: stable when the main agent re-sends the same task text. */
export function swarmConsentKey(task: string): string {
    return `swarm_task:${task.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// ── What counts as an external side effect (by tool name and action only) ──
//   always:   whatsapp_send, whatsapp_sticker, email_send, send_message_on_channel,
//             social_post, cold_outreach, delete_file, delete_document,
//             register_webhook, credential_setup
//   code:     blender_script, davinci_script (arbitrary Python in Blender / Resolve)
//   deferred: schedule_task, set_reminder, cancel_task, cron schedule/cancel,
//             task_queue add, start_long_task, resume_long_task. They run later
//             (a boot-time loop, a queue, a long task's background phases). An
//             allowed call's handler runs outside the swarm stores (outsideSwarm),
//             so that later work never inherits the step's grant: its own tool
//             calls go through the main agent's per-call consent gate.
//   by action (`operation` for git_op, `op` for cron; a missing one counts as gated):
//             messages_tool send · gmail send/reply · site_task confirm ·
//             trash_manager trash/empty · app_manager force_quit · git_op push ·
//             github create_issue, graphql mutations · marketing_schedule schedule/cancel ·
//             apple_notes delete · reminders_tool delete/delete_list · run_shortcut run ·
//             google_accounts add/complete/remove · browser_batch_fetch other than GET/HEAD
//   open_in_app: a URL scheme other than http(s)/file (shortcuts://, tel:, ...), an
//             executable or script target, or a terminal/script app
//   launchers: shell commands that stand in for a gated tool, in command position
//             (see shellGated): `shortcuts run`, `open` as open_in_app above,
//             `osascript` (and the apple_script tool) with a send/delete/keystroke verb,
//             Terminal `do script`, `run shortcut`, or `open location` of a non-http(s) URL;
//             shell_exec's `args` array counts as part of the command
//   unvetted: MCP tools and tools not built in (Forge, store, create_tool), except
//             read-only names (get/list/search/...): we can't know what they do
//   anything requiresConfirmation() flags (the main agent's gate: dangerous shell
//             patterns, destructive hotkeys, wifi off, ...); in shell, not inside the
//             arguments of a plain read/search command (`grep -rn shutdown src/`, see shellGated).
// Not gated: generic browser and desktop input (clicks, typing, keys, run_js),
// other shell commands, send_file / send_screenshot (they deliver
// only to the owner's own chat), reads, research, navigation, code edits, builds.
const ALWAYS = new Set([
    "whatsapp_send",
    "whatsapp_sticker",
    "email_send",
    "send_message_on_channel",
    "social_post",
    "cold_outreach",
    "delete_file",
    "delete_document",
    "register_webhook",
    "credential_setup",
    "blender_script",
    "davinci_script",
    "schedule_task",
    "set_reminder",
    "cancel_task",
    "start_long_task",
    "resume_long_task",
]);
const BY_ACTION: Record<string, string[]> = {
    messages_tool: ["send"],
    gmail: ["send", "reply"],
    site_task: ["confirm"],
    trash_manager: ["trash", "empty"],
    app_manager: ["force_quit"],
    git_op: ["push"],
    github: ["create_issue"],
    marketing_schedule: ["schedule", "cancel"],
    apple_notes: ["delete"],
    reminders_tool: ["delete", "delete_list"],
    run_shortcut: ["run"],
    cron: ["schedule", "cancel"],
    task_queue: ["add"],
    google_accounts: ["add", "complete", "remove"],
};
const ACTION_FIELD: Record<string, string> = { git_op: "operation", cron: "op" };

const SHELL_TEXT: Record<string, string> = {
    shell_exec: "command",
    shell_exec_background: "command",
    powershell_script: "script",
    linux_shell_script: "script",
    apple_script: "script",
};
/**
 * AppleScript that sends, deletes, types into another app, runs shell code (Terminal
 * `do script`), runs a shortcut, or opens a non-http(s)/file location.
 */
const OSA_EFFECT =
    /\b(?:send|reply|forward|delete|remove|erase|trash|empty|keystroke|key\s+code|do\s+(?:shell\s+)?script|run\s+shortcut)\b|\bopen\s+location\s+(?!["']?(?:https?|file):)/i;

/** The text a shell tool runs: shell_exec runs `${command} ${args.join(" ")}` through the shell. */
export function shellText(name: string, args: Record<string, unknown>): string {
    const text = String(args[SHELL_TEXT[name] ?? "command"] ?? "");
    return Array.isArray(args.args) && (name === "shell_exec" || name === "shell_exec_background")
        ? [text, ...args.args.map(String)].join(" ")
        : text;
}

const READ_FIRST = new Set([
    "get",
    "list",
    "search",
    "read",
    "fetch",
    "find",
    "describe",
    "view",
    "show",
    "lookup",
    "retrieve",
    "resolve",
    "scrape",
    "crawl",
]);
const MUTATION =
    /(?:^|_)(?:send|post|reply|forward|delete|remove|trash|publish|pay|purchase|buy|order|checkout|transfer|push|deploy|invite|share|create|update|write|insert|drop|execute|exec|run|schedule|tweet|sms|call|submit|book|comment|merge|set)(?:$|_)/;

/** A third-party tool whose name says it only reads (mcp_<server>__getMessages → get_messages). */
function readOnlyName(name: string): boolean {
    const tool = (name.split("__").pop() ?? "")
        .replace(/([a-z\d])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .replace(/[-.\s]+/g, "_");
    // Any read verb, not just the first word: search MCPs lead with their service name (brave_web_search).
    return tool.split("_").some((w) => READ_FIRST.has(w)) && !MUTATION.test(tool);
}

/** open_in_app / `open`: a launcher URL scheme, a terminal/script app, or an executable target. */
function opensLauncher(args: Record<string, unknown>): boolean {
    // Same fallback as the open_in_app handler: an empty target falls through to path/url.
    const target = String(args.target || args.path || args.url || "").trim();
    const scheme = /^([a-z][\w+.-]+):/i.exec(target)?.[1].toLowerCase();
    if (scheme && !["http", "https", "file"].includes(scheme)) return true;
    const app = String(args.app ?? "").trim();
    if (/\b(?:terminal|iterm\d*|script\s*editor|automator|shortcuts|python\w*|launcher|wish)\b/i.test(app)) {
        return true;
    }
    // A file opened in a named app (an editor) is opened by that app, not run.
    if (app) return false;
    return /\.(?:command|sh|bash|zsh|csh|tool|terminal|scptd?|applescript|workflow|shortcut|app|pkg|mpkg|dmg|exe|msi|bat|cmd|ps1|vbs|jar|py|rb|pl|js|mjs|webloc|inetloc|fileloc|url|desktop)\/?$/i.test(
        target,
    );
}

// Words that keep the next word in command position: shell keywords and wrappers that run their arguments.
const PREFIX =
    /^(?:sudo|doas|env|exec|nohup|command|builtin|time|nice|ionice|timeout|gtimeout|caffeinate|xargs|stdbuf|if|then|do|else|elif|while|until|\{|!|[A-Za-z_]\w*=.*)$/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Run their input or arguments as shell code: a read segment's text may reach them. */
const RUNNERS = new Set([...SHELLS, "eval", "source", "."]);
/** Read/search commands: a dangerous word in their arguments (`grep -rn shutdown`) is text, not an action. */
const READ_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "wc", "ls"]);
/** Options that make a "read" run a command (rg --pre, git grep -O, git diff --ext-diff). */
const RUNS_CMD = /^(?:--pre(?:-glob)?(?:=|$)|-O|--open-files-in-pager|--ext-diff)/;
const GIT_READ = new Set(["grep", "log", "show", "diff", "blame"]);

/** [start, end) of each simple command: split on ; & | ( ) newline outside quotes, and on ` and $( anywhere but '…'. */
function segments(command: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let start = 0;
    let quote = "";
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (quote === "'") {
            if (c === "'") quote = "";
            continue;
        }
        if (c === "\\") {
            i++;
            continue;
        }
        if (c === '"' || (!quote && c === "'")) {
            quote = quote ? "" : c;
            continue;
        }
        const sub = c === "`" || (c === "$" && command[i + 1] === "(");
        if (sub || (!quote && ";&|()\n".includes(c))) {
            out.push([start, i]);
            if (c === "$") i++;
            start = i + 1;
        }
    }
    out.push([start, command.length]);
    return out;
}

/** Shell words with quotes removed. */
function words(segment: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inWord = false;
    let quote = "";
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (quote) {
            if (c === quote) quote = "";
            else cur += c === "\\" && quote === '"' ? (segment[++i] ?? "") : c;
        } else if (c === '"' || c === "'") {
            quote = c;
            inWord = true;
        } else if (/\s/.test(c)) {
            if (inWord) out.push(cur);
            cur = "";
            inWord = false;
        } else {
            cur += c === "\\" ? (segment[++i] ?? "") : c;
            inWord = true;
        }
    }
    if (inWord) out.push(cur);
    return out;
}

const base = (word: string | undefined) => (word ?? "").split("/").pop() ?? "";

/** Indexes that may hold the command word: 0, then past prefixes, their flags and flag values (`sudo -u bob X`). */
function commandIndexes(w: string[]): number[] {
    const out = [0];
    if (!PREFIX.test(base(w[0]))) return out;
    for (let i = 1; i < w.length; i++) {
        out.push(i);
        if (!(PREFIX.test(base(w[i])) || w[i].startsWith("-") || DURATION.test(w[i]) || w[i - 1].startsWith("-")))
            break;
    }
    return out;
}

/** `open` of a launcher (see opensLauncher); `args` are the words after `open`. */
function openLaunches(args: string[]): boolean {
    let app = "";
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
        // getopt clusters: -na Terminal, -Wa X, -aTerminal (the app is the rest of the word or the next one)
        const m = /^-[A-Za-z]*?[ab](.*)$/.exec(args[i]);
        if (m) app = m[1] || (args[++i] ?? "");
        else if (!args[i].startsWith("-")) targets.push(args[i]);
    }
    if (app && opensLauncher({ app })) return true;
    return targets.some((target) => opensLauncher({ target, app }));
}

/**
 * Is this shell command (or script) an external side effect?
 * - a launcher of a gated tool's equivalent in command position (the first word of a
 *   simple command, after shell keywords and wrappers like sudo/env/xargs/timeout):
 *   `shortcuts run`, `open` of a launcher (see opensLauncher), `osascript` with an
 *   effect verb. `sh -c '…'` and `eval '…'` are checked again on their script, so
 *   `grep "shortcuts run"` or `echo open tel:1` are not launchers;
 * - what requiresConfirmation() flags (the main agent's gate), with plain read/search
 *   segments (`grep -rn shutdown src/`, first word a READ_CMDS entry or git log/show/
 *   diff/grep/blame, no VAR= or command-running option) blanked out; nothing is blanked
 *   when the command has a here-doc/here-string or runs a shell or eval anywhere, since
 *   a read's text could then be run (`cat <<< 'rm -rf ~' | sh`).
 * ponytail: aliases, functions and script files are not looked into (the accepted limit above).
 */
export function shellGated(command: string): boolean {
    let unread = command; // the command with plain read segments blanked out
    let canBlank = !command.includes("<<");
    for (const [s, e] of segments(command)) {
        const seg = command.slice(s, e);
        const w = words(seg);
        for (const j of commandIndexes(w)) {
            const cmd = base(w[j]);
            if (cmd === "shortcuts" && w[j + 1] === "run") return true;
            // `-e '…'` carries the script in this segment; a heredoc or a pipe feeds it from elsewhere.
            if (cmd === "osascript" && OSA_EFFECT.test(w.includes("-e") ? seg : command)) return true;
            if (cmd === "open" && openLaunches(w.slice(j + 1))) return true;
            if (RUNNERS.has(cmd)) canBlank = false;
            const c = SHELLS.has(cmd) ? w.findIndex((x, k) => k > j && /^-[a-z]*c[a-z]*$/i.test(x)) : -1;
            const inline =
                c > 0 ? w[c + (w[c + 1] === "--" ? 2 : 1)] : cmd === "eval" ? w.slice(j + 1).join(" ") : undefined;
            if (inline !== undefined && shellGated(inline)) return true;
        }
        const cmd = base(w[0]);
        const read = (READ_CMDS.has(cmd) || (cmd === "git" && GIT_READ.has(w[1]))) && !w.some((x) => RUNS_CMD.test(x));
        if (read) unread = unread.slice(0, s) + " ".repeat(e - s) + unread.slice(e);
    }
    return requiresConfirmation("shell_exec", { command: canBlank ? unread : command }).needsConfirmation;
}

/** Is this call an external side effect? `unvetted`: an MCP or non-built-in tool. */
export function isExternalSideEffect(name: string, args: Record<string, unknown>, unvetted = false): boolean {
    if (SHELL_TEXT[name]) {
        const text = shellText(name, args);
        return name === "apple_script" ? OSA_EFFECT.test(text) : shellGated(text);
    }
    if (requiresConfirmation(name, args).needsConfirmation) return true;
    if (unvetted || name.startsWith("mcp_")) return !readOnlyName(name);
    if (ALWAYS.has(name)) return true;
    if (name === "open_in_app") return opensLauncher(args);
    if (name === "browser_batch_fetch") return !/^(?:get|head|)$/i.test(String(args.method ?? "").trim());
    const actions = BY_ACTION[name];
    if (actions) {
        const action = args[ACTION_FIELD[name] ?? "action"];
        if (typeof action !== "string" || actions.includes(action)) return true;
        return name === "github" && action === "graphql" && /\bmutation\b/i.test(String(args.query ?? ""));
    }
    return false;
}

const TARGET_KEYS = [
    "to",
    "recipient",
    "recipients",
    "contact",
    "chat",
    "jid",
    "phone",
    "channel",
    "platform",
    "path",
    "file_path",
    "target",
    "app",
    "name",
    "branch",
    "command",
    "script",
    "url",
    "urls",
    "prompt",
    "description",
    "label",
    "selector",
    "element",
    "query",
    "text",
    "combo",
    "key",
];

/** Display only (what the owner is told was held back); never used to match. */
function summarize(name: string, args: Record<string, unknown>): string {
    const target = TARGET_KEYS.map((k) => args[k]).find(
        (v) => (typeof v === "string" && v) || typeof v === "number" || Array.isArray(v),
    );
    const op = args[ACTION_FIELD[name] ?? "action"];
    const action = typeof op === "string" && /^[\w-]{1,24}$/.test(op) ? ` ${op}` : "";
    const shown = target === undefined ? "" : String(target).replace(/\s+/g, " ");
    const to = shown ? ` → ${shown.length > 120 ? `${shown.slice(0, 120)}…` : shown}` : "";
    return `${name}${action}${to}`;
}

/**
 * null: not in a swarm, or not a side effect (run normally).
 * "allow": a side effect in a step the owner approved.
 * Otherwise the JSON tool result to return instead of running it.
 */
export async function swarmGate(
    name: string,
    args: Record<string, unknown>,
    unvetted = false,
): Promise<null | "allow" | string> {
    const run = currentSwarmRun();
    if (!run || !isExternalSideEffect(name, args, unvetted)) return null;
    const step = currentSwarmStep();
    if (step?.stepApproved || runWideGrant(run)) return "allow";

    const summary = summarize(name, args);
    // Every attempt is recorded (readers dedupe): the mesh reads the entries a step added while it ran.
    // The owner is asked once, when swarm_task returns (swarm.ts), not here mid-run.
    run.blocked.push({ step: step?.stepId, tool: name, summary });
    console.log(`  ✋ swarm: ${summary} needs the owner's OK — not run`);
    return JSON.stringify({
        error: `needs_owner_approval: ${summary} was NOT run. It needs the owner's OK first.`,
        needs_owner_approval: true,
        next_step: "Do not retry or work around this. Report that this step needs the owner's OK.",
    });
}
