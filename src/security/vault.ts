// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The owner's saved secrets (logins, API keys, cards, UPI IDs). Bhai can USE
// them but the model never SEES them:
//
//   • The desktop app keeps them in vault.enc (Electron safeStorage: Keychain /
//     Credential Manager) and hands the decrypted list to this process over its
//     stdin pipe (`##BHAI_VAULT##<json>`), at spawn and on every edit. They live
//     only in this process's memory: never on disk here, never sent to Convex.
//   • The model sees labels (vault_list) and writes tokens like
//     {{vault:<id>.password}}. resolveVaultArgs() swaps a token for its value in
//     the typing tools only (pii-vault REVEAL_TOOLS, agent.ts), at the moment
//     they run. Every value is registered with pii-vault, so a page, log line or
//     tool result that shows it gets the token back instead (protect()).
//   • Login / API-key tokens are domain-locked in the browser: they resolve only
//     on an https page on one of the entry's domains (or a subdomain; never a
//     public suffix like co.uk or github.io). The typing tool checks the origin
//     again where the keys land, right before it types (vaultTargetError: the
//     live tab, the focused frame), so a click that navigates, a redirect or a
//     tab switch can't redirect the secret. In a desktop app (os_type …) there is
//     no origin, so the owner has to OK that exact call (consent.ts).
//   • Card / UPI tokens resolve only inside a payment authorization the owner
//     approved for an item and amount (vault_authorize_payment, consent gate +
//     the Site Skill spend cap), in the browser, on the page it was made on, for
//     5 minutes, each field once. The CVV is asked for then through a desktop
//     prompt and never stored.
//   • A document a secret was typed into is tainted: page JavaScript tools are
//     refused there until it navigates (the value could be read back in a form
//     masking can't recognize).
//
// BHAI_NO_VAULT=true turns resolution and the vault tools off.

import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import psl from "psl";
import { recordSpend, spendAllowed } from "../skills/site/runtime.js";
import { checkConsent } from "./consent.js";
import { maskKnownValues, setSecrets } from "./pii-vault.js";

export type VaultEntry =
    | { id: string; label: string; kind: "login"; domains: string[]; username: string; password: string }
    | { id: string; label: string; kind: "api_key"; name: string; value: string; domains: string[] }
    | { id: string; label: string; kind: "card"; holder: string; number: string; expiry: string; brand: string }
    | { id: string; label: string; kind: "upi"; vpa: string };

export const vaultEnabled = () => process.env.BHAI_NO_VAULT !== "true";

const TOKEN_RE = /\{\{vault:([A-Za-z0-9_-]+)\.(username|password|apikey|number|expiry|holder|vpa|cvv)\}\}/g;
const tokenOf = (id: string, field: string) => `{{vault:${id}.${field}}}`;

let entries = new Map<string, VaultEntry>();

// ── Loading ───────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** "https://www.Zomato.com/login" → "zomato.com". A bare suffix ("com") is dropped. */
const normDomain = (d: unknown) =>
    str(d)
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/[/:?#].*$/, "")
        .replace(/^www\./, "");
/** A public suffix (com, co.uk, github.io, vercel.app) is anyone's site: dropped. */
const isSite = (d: string) => d.includes(".") && psl.get(d) !== null;
const domainsOf = (v: unknown) => (Array.isArray(v) ? v.map(normDomain).filter(isSite) : []);

/** Replaces the in-memory vault. Unknown kinds and any `cvv` field are dropped: a CVV is never kept. */
export function loadVault(list: unknown): void {
    const next = new Map<string, VaultEntry>();
    for (const raw of Array.isArray(list) ? list : []) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const id = str(r.id);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
        const label = str(r.label) || id;
        if (r.kind === "login")
            next.set(id, {
                id,
                label,
                kind: "login",
                domains: domainsOf(r.domains),
                username: str(r.username),
                password: str(r.password),
            });
        else if (r.kind === "api_key")
            next.set(id, {
                id,
                label,
                kind: "api_key",
                name: str(r.name),
                value: str(r.value),
                domains: domainsOf(r.domains),
            });
        else if (r.kind === "card")
            next.set(id, {
                id,
                label,
                kind: "card",
                holder: str(r.holder),
                number: str(r.number),
                expiry: str(r.expiry),
                brand: str(r.brand),
            });
        else if (r.kind === "upi") next.set(id, { id, label, kind: "upi", vpa: str(r.vpa) });
    }
    entries = next;
    auths.clear(); // an edited card must be authorized again
    stickyCvv.clear();
    // NOT tainted: a page a secret was typed into may still hold it after an edit
    // (back-nav refills the field), so the JS/screenshot lock is per-task document
    // state, cleared only at a real task boundary (resetVaultTask), not on reload.
    syncMasks();
}

/** Fields a page may show cut short (a scan shows the first 30 chars of a value). */
const PARTIAL_FIELDS = new Set(["password", "apikey", "number"]);
const PARTIAL_MIN = 8;

// Every secret value masked this task → its token. syncMasks() only ADDS: a value
// removed or changed by a mid-task vault edit stays masked (the page may still hold
// the old value) until a real task boundary (resetVaultTask) clears it.
const taskMask = new Map<string, string>();
const taskPartial = new Map<string, string>();

/** Every secret value → its token, for pii-vault's masking (plus a CVV while its authorization lasts). */
function syncMasks(): void {
    const add = (value: string, id: string, field: string) => {
        // ponytail: values under 4 chars aren't masked (they'd eat ordinary words); a 3-digit CVV is the exception.
        if (value.length >= 4 || field === "cvv") taskMask.set(value, tokenOf(id, field));
        if (PARTIAL_FIELDS.has(field))
            for (let n = PARTIAL_MIN; n < value.length; n++) taskPartial.set(value.slice(0, n), tokenOf(id, field));
    };
    for (const e of entries.values()) {
        for (const [field, value] of fieldsOf(e)) if (field !== "holder" && field !== "expiry") add(value, e.id, field);
    }
    for (const [value, token] of stickyCvv) taskMask.set(value, token);
    setSecrets(taskMask, taskPartial);
}

function fieldsOf(e: VaultEntry): Array<[string, string]> {
    if (e.kind === "login")
        return [
            ["username", e.username],
            ["password", e.password],
        ];
    if (e.kind === "api_key") return [["apikey", e.value]];
    if (e.kind === "card")
        return [
            ["number", e.number.replace(/\s+/g, "")],
            ["number", e.number],
            ["expiry", e.expiry],
            ["holder", e.holder],
        ];
    return [["vpa", e.vpa]];
}

// ── What the model sees ───────────────────────

const maskName = (u: string) => {
    if (!u) return "";
    const at = u.indexOf("@");
    return at > 0 ? `${u[0]}***${u.slice(at)}` : `${u[0]}***`;
};

export interface VaultListing {
    id: string;
    label: string;
    kind: VaultEntry["kind"];
    domains: string[];
    username_masked?: string;
    last4?: string;
    tokens: string[];
}

/** Labels and tokens only, never a value. `query` filters by label, id or domain. */
/** Query words for vault_list: a URL becomes its host ("https://www.zomato.com/login" → "zomato.com"); filler words drop. */
export function vaultQueryWords(query: string): string[] {
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .map((w) =>
            w
                .replace(/^[a-z]+:\/\//, "")
                .replace(/^www\./, "")
                .replace(/[/?#:].*$/, ""),
        )
        .filter(Boolean);
    const meaningful = words.filter((w) => w.length >= 3 && !VAULT_QUERY_FILLER.has(w));
    return meaningful.length ? meaningful : words;
}
const VAULT_QUERY_FILLER = new Set("log login sign the and for with account into my on to in".split(" "));

export function listVault(query = ""): VaultListing[] {
    const q = vaultQueryWords(query);
    const out: VaultListing[] = [];
    for (const e of entries.values()) {
        const domains = "domains" in e ? e.domains : [];
        const hay = [e.id, e.label, ...domains].join(" ").toLowerCase();
        if (q.length && !q.some((w) => hay.includes(w))) continue;
        const row: VaultListing = { id: e.id, label: e.label, kind: e.kind, domains, tokens: [] };
        if (e.kind === "login") {
            row.username_masked = maskName(e.username);
            row.tokens = [tokenOf(e.id, "username"), tokenOf(e.id, "password")];
        } else if (e.kind === "api_key") row.tokens = [tokenOf(e.id, "apikey")];
        else if (e.kind === "card") {
            row.last4 = e.number.replace(/\D/g, "").slice(-4);
            row.tokens = ["number", "expiry", "holder", "cvv"].map((f) => tokenOf(e.id, f));
        } else {
            row.username_masked = maskName(e.vpa);
            row.tokens = [tokenOf(e.id, "vpa")];
        }
        out.push(row);
    }
    return out;
}

// ── Payments ──────────────────────────────────

const AUTH_MS = 5 * 60_000;
// `used`: the fields typed under this authorization; each goes once, so one OK pays once.
const auths = new Map<string, { exp: number; site: string; cvv?: string; used: Set<string> }>();
// CVVs entered under any authorization: kept masked until the vault reloads (task
// end / an edit), outliving the 5-minute auth so a later scan can't read one back.
const stickyCvv = new Map<string, string>(); // cvv value → its token

export const siteOf = (url: string) => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" ? u.hostname.toLowerCase() : "";
    } catch {
        return "";
    }
};

// Payment-provider frames that may legitimately host a card field on a merchant
// page (Stripe, Razorpay, PayU, …). A card may sit in one of these OR in a frame
// on the merchant's own host — never in an arbitrary cross-origin ad/widget frame.
const PSP_SUFFIXES = [
    "stripe.com",
    "stripe.network",
    "razorpay.com",
    "payu.in",
    "payubiz.in",
    "ccavenue.com",
    "billdesk.com",
    "paypal.com",
    "paypalobjects.com",
    "cashfree.com",
    "phonepe.com",
    "paytm.in",
    "paytm.com",
    "instamojo.com",
    "juspay.in",
    "checkout.com",
    "adyen.com",
];
const isKnownPsp = (host: string) => !!host && PSP_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`));
const onDomains = (host: string, domains: string[]) =>
    !!host && domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Called by vault_authorize_payment AFTER the consent gate (the owner said yes
 * to this item and amount). Checks the spend cap, asks the desktop for the CVV
 * (cards), books the spend and opens a 5-minute window on `pageUrl`'s site.
 */
export async function authorizePayment(
    entryId: string,
    amount: number,
    item: string,
    host: string,
    askCvv: (label: string, item: string, amount: number, site: string) => Promise<string | null> = requestCvv,
): Promise<{ ok: true; tokens: string[]; site: string } | { error: string }> {
    if (!vaultEnabled()) return { error: "The vault is turned off (BHAI_NO_VAULT)." };
    const e = entries.get(entryId);
    if (!e || (e.kind !== "card" && e.kind !== "upi"))
        return { error: `No saved card or UPI ID with id "${entryId}". Call vault_list.` };
    if (!(amount > 0)) return { error: "amount must be the total the owner approved, above 0." };
    // The merchant host was captured from the live tab at approval time (the consent
    // gate), so the card is bound to the site the owner saw — not whatever tab is
    // live when this runs.
    const site = siteOf(host.includes("://") ? host : `https://${host}`);
    if (!site) return { error: "Open the https payment page in the browser first, then authorize there." };
    if (!spendAllowed(amount))
        return {
            error: "This is over the spend cap (per order or per day). Tell the owner; they can pay it themselves.",
        };
    let cvv: string | undefined;
    if (e.kind === "card") {
        const c = await askCvv(e.label, item, amount, site);
        if (!c || !/^\d{3,4}$/.test(c))
            return { error: "The owner didn't enter the CVV, so nothing was paid. Ask if they want to try again." };
        cvv = c;
        // The page may still show the CVV after the 5-minute window closes (a stalled
        // checkout, a scan/form_state read). Keep masking it for the rest of the task,
        // not just while the authorization lasts (the auth — and its cvv — is deleted on expiry).
        stickyCvv.set(cvv, tokenOf(entryId, "cvv"));
    }
    recordSpend(amount);
    auths.set(entryId, { exp: Date.now() + AUTH_MS, site, cvv, used: new Set() });
    syncMasks();
    setTimeout(() => expire(entryId), AUTH_MS).unref?.();
    return { ok: true, site, tokens: listVault().find((r) => r.id === entryId)?.tokens ?? [] };
}

function expire(id: string): void {
    const a = auths.get(id);
    if (a && a.exp <= Date.now()) {
        auths.delete(id);
        syncMasks();
    }
}

// ── Resolution (agent.ts, REVEAL_TOOLS only) ──

/** Typing tools that act on the browser page; every other reveal tool types into a desktop app. */
const BROWSER_TYPING = new Set(["browser_type", "browser_keyboard"]);

export interface VaultContext {
    isOwner: boolean;
    /** The active browser tab's live URL; only called when a browser tool carries a token. */
    pageUrl: () => Promise<string>;
}

/**
 * Where one resolved token may be typed. Login / API key: the focused frame's
 * host is on `domains` (or a subdomain). Payment: the top page's host is the
 * authorized site, and the field may sit in any https frame (a PSP's card iframe).
 */
export interface VaultRule {
    token: string;
    domains: string[];
    payment: boolean;
}

/** A tool call carrying resolved vault values (agent.ts runs it inside runVaultCall). */
export interface VaultCall {
    tool: string;
    rules: VaultRule[];
}
const calls = new AsyncLocalStorage<VaultCall>();
export const runVaultCall = <T>(call: VaultCall, fn: () => Promise<T>): Promise<T> => calls.run(call, fn);
/** The vault call in progress, if this code runs under one (typing tools, executeTool's hooks). */
export const vaultCall = (): VaultCall | undefined => calls.getStore();

const ANY_TOKEN = new RegExp(TOKEN_RE.source); // non-global: no lastIndex state shared with matchAll/replace
export const hasVaultToken = (args: unknown) => ANY_TOKEN.test(JSON.stringify(args ?? ""));

/** True when a vault token sits in a key/combo/hotkey field anywhere in the args (incl. os_multi_action's actions[]). */
function tokenInKeyField(v: unknown): boolean {
    if (Array.isArray(v)) return v.some(tokenInKeyField);
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        // os_computer_action / os_multi_action press keys via `text` when action
        // is "key"/"hold_key" — so a token there is a key press, not typed text.
        const keyAction = o.action === "key" || o.action === "hold_key";
        for (const [k, x] of Object.entries(o)) {
            const isKeyField = k === "key" || k === "combo" || k === "hotkey" || (keyAction && k === "text");
            if (isKeyField && typeof x === "string" && ANY_TOKEN.test(x)) return true;
            if (tokenInKeyField(x)) return true;
        }
    }
    return false;
}

/**
 * Null when every rule allows typing where the keys land now: `top` is the live
 * top-level URL, `frame` the URL of the frame holding focus ("" = unknown, e.g.
 * focus in a frame we can't see). Called by the typing tool right before it types.
 */
export function vaultTargetError(rules: VaultRule[], top: string, frame: string): string | null {
    const topHost = siteOf(top);
    const frameHost = siteOf(frame);
    for (const r of rules) {
        const host = r.payment ? topHost : frameHost;
        // Payment: the top page is the authorized merchant, and the card field is
        // on the merchant's own host or a known payment provider's frame — not an
        // arbitrary cross-origin ad/widget iframe on the page.
        const ok = r.payment
            ? topHost === r.domains[0] && (frameHost === topHost || isKnownPsp(frameHost))
            : onDomains(host, r.domains);
        if (!ok) {
            const where =
                frameHost && frameHost !== topHost
                    ? `${topHost || top} (focus in a frame on ${frameHost})`
                    : topHost || "a non-https page";
            console.warn(`  🔐 [vault] refused ${r.token} at ${where}`);
            return `${r.token}: the page changed before typing (now ${where}; allowed: ${r.domains.join(", ")}). Refused, nothing was typed. Check the page and try again.`;
        }
    }
    return null;
}

// Origins a secret was typed into: page JavaScript is refused and screenshots are
// withheld there, for the rest of the task (back/forward can refill the field on a
// new document of the same origin). Cleared only at a task boundary (resetVaultTask),
// NOT on a vault reload — a mid-task edit/delete must not re-open the page. One per origin.
const tainted = new Set<string>();
export const noteSecretTyped = (origin: string): void => {
    tainted.add(origin);
};
export const secretTypedIn = (origin: string): boolean => tainted.has(origin);
/** True once any saved secret has been typed into a page this task (cheap screenshot gate). */
export const anySecretTyped = (): boolean => tainted.size > 0;

/**
 * A new top-level agent turn: forget which origins were tainted and which removed
 * secret values we were still masking from the previous task. Called from agent.ts
 * per non-forked turn; sub-agents (forked) share the task and don't reset it.
 */
export function resetVaultTask(): void {
    tainted.clear();
    taskMask.clear();
    taskPartial.clear();
    syncMasks(); // rebuild the mask from the current vault only
}

/** A stable text for a consent key / question: tokens as written, values masked. */
const describeArgs = (args: Record<string, unknown>) =>
    maskKnownValues(
        JSON.stringify(
            Object.fromEntries(
                Object.entries(args)
                    .filter(([k]) => k !== "confirmed")
                    .sort(),
            ),
        ),
    );

/**
 * Swaps every {{vault:id.field}} in `args` for its value, or refuses the whole
 * call with an error for the model. The result goes to the tool only; the
 * caller keeps the tokens for logs and history. For a browser tool, `rules` is
 * what the tool must re-check where the keys land (vaultTargetError).
 */
export async function resolveVaultArgs<T>(
    tool: string,
    args: T,
    ctx: VaultContext,
): Promise<{ args: T; rules: VaultRule[] } | { error: string }> {
    if (!hasVaultToken(args)) return { args, rules: [] };
    if (!vaultEnabled()) return { error: "The vault is turned off (BHAI_NO_VAULT), so saved secrets can't be typed." };
    if (!ctx.isOwner) return { error: "Saved secrets can only be used for the owner." };
    // A saved secret is typed as text only — never a key name or hotkey combo. The
    // OS layer lowercases (mac) / uppercases (win) a key and echoes it in an
    // "unknown key" error, which masking (exact forms + prefixes) wouldn't catch.
    if (tokenInKeyField(args))
        return {
            error: 'A saved secret can only be typed as text, not as a key name or hotkey. Put the {{vault:…}} token in the "text" field.',
        };
    if (tool === "browser_multi_action" || tool === "site_task") {
        return {
            error: "Type saved secrets with browser_type, one field per call (a multi-step action or a Site Skill could leave the site, or keep the value, before it types).",
        };
    }
    const found = [...JSON.stringify(args).matchAll(TOKEN_RE)].map((m) => ({ id: m[1], field: m[2], token: m[0] }));
    const values = new Map<string, string>();
    const rules: VaultRule[] = [];
    const inBrowser = BROWSER_TYPING.has(tool);
    const host = inBrowser ? siteOf(await ctx.pageUrl().catch(() => "")) : "";
    const desktopAsks: string[] = [];

    for (const { id, field, token } of found) {
        const e = entries.get(id);
        if (!e) return { error: `${token}: no saved entry with id "${id}". Call vault_list.` };
        const value = secretOf(e, field);
        if (value === undefined) return { error: `${token}: a ${e.kind} entry has no "${field}".` };

        if (e.kind === "card" || e.kind === "upi") {
            const a = auths.get(id);
            if (!a || a.exp <= Date.now()) {
                return {
                    error: `${token}: paying with "${e.label}" needs the owner's OK for the item and amount first. Call vault_authorize_payment on the payment page.`,
                };
            }
            if (!inBrowser)
                return {
                    error: `${token}: a saved card or UPI ID is only typed into the payment page in the browser, with browser_type.`,
                };
            if (host !== a.site) {
                return {
                    error: `${token}: the payment was authorized on ${a.site}, but this page is ${host || "not an https page"}. Refused.`,
                };
            }
            if (a.used.has(field) || (field === "cvv" && !a.cvv))
                return {
                    error: `${token}: already typed once for this payment. If it has to be typed again, call vault_authorize_payment again (the owner approves it again).`,
                };
            rules.push({ token, domains: [a.site], payment: true });
        } else if (inBrowser) {
            if (!e.domains.length)
                return {
                    error: `${token}: "${e.label}" has no website saved, so it can't be typed into a page. The owner can add one in Settings → Vault.`,
                };
            if (!onDomains(host, e.domains)) {
                console.warn(
                    `  🔐 [vault] refused ${id}.${field} on ${host || "a non-https page"} (saved for ${e.domains.join(", ")})`,
                );
                return {
                    error: `${token}: "${e.label}" is saved for ${e.domains.join(", ")}, but this page is ${host || "not an https page"}. Refused: a page can't get a secret meant for another site.`,
                };
            }
            rules.push({ token, domains: e.domains, payment: false });
        } else desktopAsks.push(`${e.label} ${field}`);
        values.set(token, value);
    }

    if (desktopAsks.length) {
        const a = (args ?? {}) as Record<string, unknown>;
        // The whole call (tokens as written, every other argument) is what the owner OKs:
        // a yes for one place doesn't type into another.
        const call = describeArgs(a);
        const target =
            a.app || a.window
                ? `into ${String(a.app ?? a.window)}`
                : a.x !== undefined || a.coordinate !== undefined
                  ? `at screen position ${JSON.stringify(a.coordinate ?? [a.x, a.y])}`
                  : "into whatever app and field has focus at that moment";
        if (checkConsent(`vault_desktop:${tool}:${call}`, a.confirmed === true, { nextTurnOnly: true }) !== "granted") {
            return {
                error: `Typing ${desktopAsks.join(", ")} with ${tool} ${target} needs the owner's OK (no website to check it against; it may also show on screen). The exact call: ${tool} ${call}. Ask them; only if their very next message is a yes, repeat this same call with confirmed: true.`,
            };
        }
        console.log(`  🔐 [vault] owner approved typing ${desktopAsks.join(", ")} via ${tool} ${target}`);
    }

    // Each card / UPI field once per authorization. The CVV stays masked until
    // the authorization ends, so the result of the call that typed it is still
    // protected (agent.ts protects it right after the call).
    for (const { id, field } of found) auths.get(id)?.used.add(field);

    const swap = (v: unknown): unknown => {
        if (typeof v === "string") return v.replace(TOKEN_RE, (t) => values.get(t) ?? t);
        if (Array.isArray(v)) return v.map(swap);
        if (v && typeof v === "object") {
            return Object.fromEntries(
                Object.entries(v)
                    .filter(([k]) => k !== "confirmed" || !desktopAsks.length)
                    .map(([k, x]) => [k, swap(x)]),
            );
        }
        return v;
    };
    return { args: swap(args) as T, rules };
}

function secretOf(e: VaultEntry, field: string): string | undefined {
    if (e.kind === "login") return field === "username" ? e.username : field === "password" ? e.password : undefined;
    if (e.kind === "api_key") return field === "apikey" ? e.value : undefined;
    if (e.kind === "upi") return field === "vpa" ? e.vpa : undefined;
    if (field === "number") return e.number.replace(/\s+/g, "");
    if (field === "expiry") return e.expiry;
    if (field === "holder") return e.holder;
    if (field === "cvv") return auths.get(e.id)?.cvv ?? "";
    return undefined;
}

// ── Desktop channel (stdin in, stdout out) ────
// The same marker convention the bot already uses on stdout (##BHAI_BUDDY##),
// in both directions. Only the parent app holds this process's stdin.

let desktopAttached = false;
let cvvSeq = 0;
const cvvWaiters = new Map<number, (cvv: string | null) => void>();

/** At boot: listen for the vault (and CVV answers) from the desktop app. No-op outside it. */
export function initVault(): void {
    if (desktopAttached || process.stdin.isTTY || !process.env.BHAI_USER_DATA_DIR) return;
    desktopAttached = true;
    const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", handleDesktopLine);
    rl.on("close", () => {
        desktopAttached = false;
    });
}

export function handleDesktopLine(line: string): void {
    try {
        if (line.startsWith("##BHAI_VAULT##")) {
            loadVault(JSON.parse(line.slice(14)));
            console.log(`  🔐 [vault] ${entries.size} saved entr${entries.size === 1 ? "y" : "ies"} loaded`);
        } else if (line.startsWith("##BHAI_VAULT_CVV##")) {
            const m = JSON.parse(line.slice(18)) as { id?: number; cvv?: string | null };
            cvvWaiters.get(Number(m.id))?.(typeof m.cvv === "string" ? m.cvv : null);
        } else if (line === "##BHAI_RESUME##") {
            // Not the vault's, but this is the bot's one reader of desktop lines: the machine woke.
            void import("../tools/scheduled.js").then((m) => m.cronTimersOnWake());
        }
    } catch {
        /* malformed line */
    }
}

function requestCvv(label: string, item: string, amount: number, site: string): Promise<string | null> {
    if (!desktopAttached) return Promise.resolve(null);
    const id = ++cvvSeq;
    return new Promise((resolve) => {
        const done = (cvv: string | null) => {
            clearTimeout(timer);
            cvvWaiters.delete(id);
            resolve(cvv);
        };
        const timer = setTimeout(() => done(null), 120_000);
        cvvWaiters.set(id, done);
        // `site` tells the owner which merchant the card goes to, in the CVV prompt itself.
        process.stdout.write(
            `##BHAI_VAULT_CVV##${JSON.stringify({ id, label, item: item.slice(0, 120), amount, site })}\n`,
        );
    });
}
