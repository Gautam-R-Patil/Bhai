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
import { knownForms } from "./value-forms.js";

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
    // A value revealed for typing can come back bare in a tool result ("typed":
    // "482913") where the patterns no longer see an OTP: hide every known value.
    // Every form a page, URL, form body, JSON or base64 can show the value in
    // (value-forms.ts), longest first. Short forms (<8 chars) only as whole
    // tokens: "1000" must not eat the middle of "10000" or "port 31000".
    for (const [value, handle] of handleOf) {
        for (const [form, short] of formsOf(value)) {
            if (!text.includes(form)) continue;
            if (!short) text = text.split(form).join(handle);
            else {
                const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "gu"), handle);
            }
        }
    }
    const redacted = redactPii(text, handleOf);
    const handles = redacted.handles;
    // Credentials by structure (Authorization headers, password=…, provider keys,
    // cookies, JWTs): credential-mask.ts. Masked for good — the model
    // never needs them. ATLAS_NO_CREDENTIAL_POLICY=true turns it off.
    const out =
        opts.credentials === false || process.env.ATLAS_NO_CREDENTIAL_POLICY === "true"
            ? redacted.text
            : maskCredentials(redacted.text);
    for (const [value, handle] of handles) valueByHandle.set(handle, value);
    if (handleOf.size > MAX_VALUES) {
        // ponytail: drops the oldest values wholesale; an old handle then stays a handle.
        const drop = [...handleOf.keys()].slice(0, handleOf.size - MAX_VALUES);
        for (const v of drop) {
            valueByHandle.delete(handleOf.get(v) as string);
            handleOf.delete(v);
            formsCache.delete(v);
        }
    }
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
