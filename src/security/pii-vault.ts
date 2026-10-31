// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

// One regex over every form of every known value, rebuilt when the vault
// changes. It is a lookahead, so it reports every position a form starts at
// (the longest form there) — overlapping ones too: a single left-to-right pass
// let a value that starts earlier ("904111" before "4111 1111 1111 1111")
// consume the start of a stored card and leak the rest. Short forms (<8 chars)
// only count as whole tokens, inside the regex.
const HANDLE_RE = /\[(?:CARD|AADHAAR|UPI|OTP|COOKIE)_\d+\]/g;
// Issued handles and vault tokens: a form lying inside one is not a value (a
// saved password "password" inside "{{vault:x.password}}" would otherwise be
// masked again and again, forever).
const MASK_RE = /\[(?:CARD|AADHAAR|UPI|OTP|COOKIE)_\d+\]|\{\{vault:[A-Za-z0-9_-]+\.[a-z]+\}\}/g;
const handleByForm = new Map<string, string>();
const anywhere = new Set<string>(); // forms masked even inside a word (saved secrets)
const SECRET_ANYWHERE = 6;
let formsRe: RegExp | null = null;
let formsGen = -1;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byLength = (a: string, b: string) => b.length - a.length;

function knownFormsRe(): RegExp | null {
    if (formsGen === generation) return formsRe;
    formsGen = generation;
    handleByForm.clear();
    // The first value stored keeps a form two values share (as the per-value loop did).
    // Saved secrets first: a form one shares with a handled value stays the vault token.
    // A saved secret (6+ chars) and its partials count anywhere, not only as whole
    // tokens: "x" + "pass12" must not carry a password past the mask.
    anywhere.clear();
    for (const [value, token] of secrets)
        for (const [form] of formsOf(value)) {
            if (!handleByForm.has(form)) handleByForm.set(form, token);
            if (form.length >= SECRET_ANYWHERE) anywhere.add(form);
        }
    for (const [form, token] of partials) {
        if (!handleByForm.has(form)) handleByForm.set(form, token);
        anywhere.add(form);
    }
    for (const [value, handle] of handleOf)
        for (const [form] of formsOf(value)) if (!handleByForm.has(form)) handleByForm.set(form, handle);
    const forms = [...handleByForm.keys()];
    const isShort = (f: string) => f.length < SHORT_FORM && !anywhere.has(f);
    const long = forms.filter((f) => !isShort(f)).sort(byLength);
    const short = forms.filter(isShort).sort(byLength).map(escapeRe);
    // Longest first. A saved secret can make a "long" form shorter than a short one;
    // only then is each short form placed by its length (slower, rare).
    const alts = long.map(escapeRe);
    const shortGroup = (fs: string[]) => String.raw`(?<![\p{L}\p{N}])(?:${fs.join("|")})(?![\p{L}\p{N}])`;
    if (short.length && long.length && long[long.length - 1].length < SHORT_FORM) {
        const all = forms.sort(byLength).map((f) => (isShort(f) ? shortGroup([escapeRe(f)]) : escapeRe(f)));
        alts.splice(0, alts.length, ...all);
    } else if (short.length) alts.push(shortGroup(short));
    formsRe = forms.length ? new RegExp(`(?=(${alts.join("|")}))`, "gu") : null;
    return formsRe;
}

type Span = [start: number, end: number, replacement: string];

/**
 * The spans one pass replaces, sorted and disjoint. Every occurrence of every
 * form is covered: overlapping occurrences merge into one span, written as the
 * handles of the occurrences that cover it ("[OTP_1][CARD_1]"). An issued
 * handle ([OTP_12]) stays as written, and a form lying wholly inside handles
 * ("12") is not a value; handle-shaped text never issued ("[OTP_9041]") is
 * plain text, so the 9041 in it is masked. Exported for the property test.
 */
// A saved secret a page echoes back with a separator between every character
// ("s k - l i v e - 3 e 9 a") slips past the literal forms. Strip separators,
// find the normalized secret, and map the span back to the original text. Costs
// nothing unless vault secrets are loaded (secretNormMap is then non-empty).
function normSpans(text: string): Span[] {
    if (secretNormMap.size === 0) return [];
    let norm = "";
    const start: number[] = [];
    const end: number[] = [];
    let i = 0;
    for (const ch of text) {
        const nc = ch.toLowerCase();
        if (nc.length === 1 && /[\p{L}\p{N}@]/u.test(nc)) {
            norm += nc;
            start.push(i);
            end.push(i + ch.length);
        }
        i += ch.length;
    }
    const spans: Span[] = [];
    for (const [ns, token] of secretNormMap) {
        for (let idx = norm.indexOf(ns); idx >= 0; idx = norm.indexOf(ns, idx + ns.length)) {
            const s = start[idx];
            const e = end[idx + ns.length - 1];
            if (e - s > ns.length) spans.push([s, e, token]); // only when spread out; literal forms cover the rest
        }
    }
    return spans;
}

export function knownValueSpans(text: string): Span[] {
    const re = knownFormsRe();
    if (!re) return [];
    const handles: Span[] = [];
    for (const m of text.matchAll(MASK_RE))
        if (valueByHandle.has(m[0]) || secretTokens.has(m[0])) handles.push([m.index, m.index + m[0].length, m[0]]);
    const occ: Span[] = [];
    let h = 0;
    for (const m of text.matchAll(re)) {
        const s = m.index;
        const e = s + m[1].length;
        while (h < handles.length && handles[h][1] <= s) h++;
        let at = s; // walk the handles from s: does any char of [s, e) lie outside them?
        for (let k = h; k < handles.length && handles[k][0] <= at && at < e; k++) at = handles[k][1];
        if (at < e) occ.push([s, e, handleByForm.get(m[1]) as string]);
    }
    occ.push(...normSpans(text)); // char-spaced echoes of a saved secret
    if (!occ.length) return [];
    occ.push(...handles);
    occ.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    // Greedy interval cover of each overlapping run: from its start, take the
    // occurrence reaching furthest, until nothing overlaps the covered end.
    const out: Span[] = [];
    for (let i = 0; i < occ.length; ) {
        const [start, first, rep] = occ[i++];
        let end = first;
        let r = rep;
        for (;;) {
            let best = -1;
            for (; i < occ.length && occ[i][0] < end; i++) if (occ[i][1] > end && (best < 0 || occ[i][1] > occ[best][1])) best = i;
            if (best < 0) break;
            end = occ[best][1];
            r += occ[best][2];
        }
        out.push([start, end, r]);
    }
    return out;
}

/**
 * A value revealed for typing can come back bare in a tool result ("typed":
 * "482913") where the patterns no longer see an OTP: hide every known value, in
 * every form a page, URL, form body, JSON or base64 can show it (value-forms.ts).
 * Short forms (<8 chars) only as whole tokens: "1000" must not eat the middle
 * of "10000" or "port 31000". Repeated until nothing changes: masking a card can
 * leave a short value glued to it ("1234" in "12344111…") standing alone.
 * Exported for the property test.
 */
export function maskKnownValues(text: string): string {
    for (let prev = ""; prev !== text; ) {
        prev = text;
        let out = "";
        let pos = 0;
        for (const [s, e, rep] of knownValueSpans(text)) {
            out += text.slice(pos, s) + rep;
            pos = e;
        }
        if (pos) text = out + text.slice(pos);
    }
    return text;
}

// protect() is a pure function of (text, credentials, vault generation), and an
// agent turn re-protects the whole history before every LLM call: remember the
// answers, up to ~4M chars of text. BHAI_NO_PROTECT_CACHE=true turns it off.
const MEMO = process.env.BHAI_NO_PROTECT_CACHE !== "true";
const MEMO_CHARS = 4_000_000;
type Memo = { gen: number; out: [plain?: string, credentials?: string] };
const memo = new Map<string, Memo>(); // insertion order = LRU order
let memoChars = 0;
const memoSize = (text: string, e: Memo) => text.length + (e.out[0]?.length ?? 0) + (e.out[1]?.length ?? 0);

// Dropped after 10 minutes with no protect() call (no turn running): up to ~8 MB held for
// nothing between conversations. One timer, armed only while the memo holds something.
const MEMO_IDLE_MS = 10 * 60_000;
let memoUsedAt = 0;
let memoTimer: ReturnType<typeof setTimeout> | null = null;
function armMemoIdle(delay = MEMO_IDLE_MS) {
    memoTimer = setTimeout(() => {
        const idle = Date.now() - memoUsedAt;
        if (idle < MEMO_IDLE_MS) return armMemoIdle(MEMO_IDLE_MS - idle);
        memo.clear();
        memoChars = 0;
        memoTimer = null;
    }, delay);
    memoTimer.unref?.();
}

/** Texts the protect() memo holds now (tests). */
export const _protectMemoSizeForTests = () => memo.size;

function remember(text: string, slot: 0 | 1, out: string) {
    if (!memoTimer) armMemoIdle();
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

// Saved secrets (vault.ts): value → its {{vault:…}} token. Masked like the
// values above but never evicted, and reveal() never turns them back: only
// vault.ts resolves a token, under its own domain lock and consent rules.
let secrets = new Map<string, string>();
// Raw fragments of saved secrets (a page that shows the first 30 chars of a
// typed key) → token, masked as-is wherever they appear.
let partials = new Map<string, string>();
// Every saved secret, normalized: reveal() never turns a handle back into one
// ("4111-1111-1111-1111" as [CARD_1], an uppercased UPI ID as [UPI_1]).
let secretNorms = new Set<string>();
let secretTokens = new Set<string>();
const normSecret = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}@]/gu, "");
// Normalized secret (separators stripped) → token, for catching a value a page
// echoes back spaced out char-by-char ("s k - l i v e - …") to dodge the literal
// forms. Only 8+ normalized chars, so a short value can't collide by chance.
const NORM_SECRET_MIN = 8;
let secretNormMap = new Map<string, string>();

/** Replace the set of saved secrets protect() hides (vault.ts calls it on every vault load). */
export function setSecrets(next: Map<string, string>, nextPartials = new Map<string, string>()): void {
    for (const v of secrets.keys()) formsCache.delete(v);
    secrets = new Map(next);
    partials = new Map(nextPartials);
    secretNorms = new Set([...secrets.keys()].map(normSecret).filter(Boolean));
    secretNormMap = new Map();
    for (const [value, token] of secrets) {
        const n = normSecret(value);
        if (n.length >= NORM_SECRET_MIN) secretNormMap.set(n, token);
    }
    secretTokens = new Set(secrets.values());
    generation++;
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
    const credentials = opts.credentials !== false && process.env.BHAI_NO_CREDENTIAL_POLICY !== "true";
    const slot = credentials ? 1 : 0;
    const gen = generation;
    if (MEMO) {
        memoUsedAt = Date.now();
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
    // never needs them. BHAI_NO_CREDENTIAL_POLICY=true turns it off.
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

export function reveal(text: string): string {
    return text.replace(HANDLE_RE, (h) => {
        const v = valueByHandle.get(h);
        // A saved card or UPI ID a page showed in another format stays a handle:
        // only vault.ts hands those out, under its payment rules.
        return v === undefined || secretNorms.has(normSecret(v)) ? h : v;
    });
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
 * What may be written to disk (conversation archive, session buffer): masked like
 * the model's view, plus credentials in every message — the owner's "my password
 * is …" included. Handles mean nothing after a restart, so no value is at rest.
 */
export const protectForDisk = <M extends Msg>(messages: M[]): M[] => protectMessages(messages, { allCredentials: true });

/**
 * protect() over the text of every message (image parts are left alone). The
 * credential policy applies to tool results from pages, email, apps and the
 * web — not to code-tool results, nor to what the owner or Bhai wrote (a pasted
 * snippet must reach the model as written).
 */
export function protectMessages<M extends Msg>(messages: M[], opts: { allCredentials?: boolean } = {}): M[] {
    const toolName = new Map<string, string>();
    for (const m of messages) for (const c of m.tool_calls ?? []) if (c.id && c.function?.name) toolName.set(c.id, c.function.name);
    return messages.map((m) => {
        const credentials =
            opts.allCredentials || (m.role === "tool" && !CODE_TOOLS.has(toolName.get(m.tool_call_id ?? "") ?? ""));
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
