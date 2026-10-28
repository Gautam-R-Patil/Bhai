// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Keeps card numbers, Aadhaar numbers, UPI IDs, one-time codes and cookie
// values out of LLM payloads and logs while still letting Bhai use them.
//
//   protect(text)  → the same text with each value swapped for a handle
//                    ([CARD_1], [OTP_2] …); the value is remembered here.
//   reveal(text)   → handles swapped back. Only the typing tools call this, at
//                    the moment they type into a page or app (agent.ts), so the
//                    model can say "type [OTP_1] into the code box" without
//                    ever seeing the code. Any other tool (a message, an email)
//                    gets the handle, never the value.
//
// Values live in memory for this process only, capped so it can't grow forever.

import { redactPii } from "./pii-redactor.js";
import { maskCredentials } from "./credential-mask.js";
import { knownForms, SHORT_FORM } from "./value-forms.js";

const formsCache = new Map<string, Array<readonly [string, boolean]>>();
const formsOf = (value: string) => {
    let f = formsCache.get(value);
    if (!f) {
        f = knownForms(value);
        formsCache.set(value, f);
    }
    return f;
};

const MAX_VALUES = 500;
const handleOf = new Map<string, string>(); // value → handle
const valueByHandle = new Map<string, string>(); // handle → value
/** Bumped on every vault add and evict: what protect() returns for a text only changes with it. */
let generation = 0;

// One regex over every form of every known value, longest first, rebuilt when
// the vault changes. Handle text ([OTP_12]) is its first alternative so a
// short value ("12") is never masked inside a handle.
const HANDLE_TEXT = String.raw`\[(?:CARD|AADHAAR|UPI|OTP|COOKIE)_\d+\]`;
const handleByForm = new Map<string, string>();
let formsRe: RegExp | null = null;
let formsGen = -1;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORDISH_BEFORE = /[\p{L}\p{N}]$/u;
const WORDISH_AFTER = /^[\p{L}\p{N}]/u;

function knownFormsRe(): RegExp | null {
    if (formsGen === generation) return formsRe;
    formsGen = generation;
    handleByForm.clear();
    // The first value stored keeps a form two values share (as the per-value loop did).
    for (const [value, handle] of handleOf)
        for (const [form] of formsOf(value)) if (!handleByForm.has(form)) handleByForm.set(form, handle);
    const alts = [...handleByForm.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    formsRe = alts.length ? new RegExp(`${HANDLE_TEXT}|${alts.join("|")}`, "gu") : null;
    return formsRe;
}

/**
 * A value revealed for typing can come back bare in a tool result ("typed":
 * "482913") where the patterns no longer see an OTP: hide every known value, in
 * every form a page, URL, form body, JSON or base64 can show it (value-forms.ts).
 * Short forms (<8 chars) only as whole tokens: "1000" must not eat the middle
 * of "10000" or "port 31000".
 */
function maskKnownValues(text: string): string {
    const re = knownFormsRe();
    if (!re) return text;
    return text.replace(re, (m: string, at: number) => {
        const handle = handleByForm.get(m);
        if (!handle) return m; // handle text
        if (m.length >= SHORT_FORM) return handle;
        const glued =
            WORDISH_BEFORE.test(text.slice(Math.max(0, at - 2), at)) ||
            WORDISH_AFTER.test(text.slice(at + m.length, at + m.length + 2));
        return glued ? m : handle;
    });
}

// protect() is a pure function of (text, credentials, vault generation), and an
// agent turn re-protects the whole history before every LLM call: remember the
// answers, up to ~4M chars of text. ATLAS_NO_PROTECT_CACHE=true turns it off.
const MEMO = process.env.ATLAS_NO_PROTECT_CACHE !== "true";
const MEMO_CHARS = 4_000_000;
type Memo = { gen: number; out: [plain?: string, credentials?: string] };
const memo = new Map<string, Memo>(); // insertion order = LRU order
let memoChars = 0;
const memoSize = (text: string, e: Memo) => text.length + (e.out[0]?.length ?? 0) + (e.out[1]?.length ?? 0);

function remember(text: string, slot: 0 | 1, out: string) {
    let e = memo.get(text);
    if (e) {
        memo.delete(text);
        memoChars -= memoSize(text, e);
        if (e.gen !== generation) e = undefined;
    }
    e ??= { gen: generation, out: [] };
    e.out[slot] = out;
    memo.set(text, e);
    memoChars += memoSize(text, e);
    for (const [k, v] of memo) {
        if (memoChars <= MEMO_CHARS) break;
        memo.delete(k);
        memoChars -= memoSize(k, v);
    }
}

/**
 * Tools whose results are source code or files the agent edits: the credential
 * policy would rewrite `const apiKey = getKey(config);` to `const apiKey =
 * [redacted]);`, and an edit or write built on that corrupts the user's file.
 * (Their own secret handling: sensitive paths are refused, grep/read/shell
 * output goes through sanitizeSecrets.)
 */
export const CODE_TOOLS = new Set([
    "read", "read_file", "write", "edit", "multi_edit", "append_file", "grep", "glob", "list_directory",
    "codebase_query", "codebase_index", "code_change_summary", "git_op", "lsp", "shell_exec",
    "shell_exec_background", "test_run", "agents_md_scaffold", "scaffold_project",
]);

/**
 * `credentials` (default on): also mask credentials by structure
 * (credential-mask.ts). Off for code-tool results and for what the owner or Bhai wrote.
 */
export function protect(text: string, opts: { credentials?: boolean } = {}): string {
    if (!text) return text;
    const credentials = opts.credentials !== false && process.env.ATLAS_NO_CREDENTIAL_POLICY !== "true";
    const slot = credentials ? 1 : 0;
    const gen = generation;
    if (MEMO) {
        const hit = memo.get(text);
        const out = hit?.gen === gen ? hit.out[slot] : undefined;
        if (out !== undefined) {
            memo.delete(text); // refresh its LRU position
            memo.set(text, hit as Memo);
            return out;
        }
    }
    const before = handleOf.size;
    const redacted = redactPii(maskKnownValues(text), handleOf);
    // Credentials by structure (Authorization headers, password=…, provider keys,
    // cookies, JWTs): credential-mask.ts. Masked for good — the model
    // never needs them. ATLAS_NO_CREDENTIAL_POLICY=true turns it off.
    const out = credentials ? maskCredentials(redacted.text) : redacted.text;
    if (handleOf.size > before) {
        generation++;
        let i = 0;
        for (const [value, handle] of handleOf) if (i++ >= before) valueByHandle.set(handle, value);
    }
    if (handleOf.size > MAX_VALUES) {
        // ponytail: drops the oldest values wholesale; an old handle then stays a handle.
        const drop = [...handleOf.keys()].slice(0, handleOf.size - MAX_VALUES);
        for (const v of drop) {
            valueByHandle.delete(handleOf.get(v) as string);
            handleOf.delete(v);
            formsCache.delete(v);
        }
        generation++;
    }
    // A call that stored a value isn't remembered: the next one masks it as a known value first.
    if (MEMO && generation === gen) remember(text, slot, out);
    return out;
}

const HANDLE_RE = /\[(?:CARD|AADHAAR|UPI|OTP|COOKIE)_\d+\]/g;

export function reveal(text: string): string {
    return text.replace(HANDLE_RE, (h) => valueByHandle.get(h) ?? h);
}

/** Tools that type into a page or app — the only place a handle becomes its value again. */
export const REVEAL_TOOLS = new Set([
    "browser_type",
    "browser_keyboard",
    "browser_multi_action",
    "os_type",
    "win_os_type",
    "os_multi_action",
    "os_computer_action",
    "site_task", // types the user's OTP answer into the page
]);

/** reveal() over every string in a tool's arguments. */
export function revealArgs<T>(args: T): T {
    if (typeof args === "string") return reveal(args) as T;
    if (Array.isArray(args)) return args.map(revealArgs) as T;
    if (args && typeof args === "object") {
        return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, revealArgs(v)])) as T;
    }
    return args;
}

type Part = { type?: string; text?: string };
type Msg = {
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
};

/**
 * protect() over the text of every message (image parts are left alone). The
 * credential policy applies to tool results from pages, email, apps and the
 * web — not to code-tool results, nor to what the owner or Bhai wrote (a pasted
 * snippet must reach the model as written).
 */
export function protectMessages<M extends Msg>(messages: M[]): M[] {
    const toolName = new Map<string, string>();
    for (const m of messages) for (const c of m.tool_calls ?? []) if (c.id && c.function?.name) toolName.set(c.id, c.function.name);
    return messages.map((m) => {
        const credentials = m.role === "tool" && !CODE_TOOLS.has(toolName.get(m.tool_call_id ?? "") ?? "");
        if (typeof m.content === "string") return { ...m, content: protect(m.content, { credentials }) };
        if (Array.isArray(m.content)) {
            return {
                ...m,
                content: (m.content as Part[]).map((p) =>
                    p?.type === "text" && p.text ? { ...p, text: protect(p.text, { credentials }) } : p,
                ),
            };
        }
        return m;
    });
}
