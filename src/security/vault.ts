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
//     on an https page on one of the entry's domains (or a subdomain). In a
//     desktop app (os_type …) there is no origin, so the owner has to OK it
//     (consent.ts) and the use is logged.
//   • Card / UPI tokens resolve only inside a payment authorization the owner
//     approved for an item and amount (vault_authorize_payment, consent gate +
//     the Site Skill spend cap), on the page it was made on, for 5 minutes. The
//     CVV is asked for then through a desktop prompt, typed once, never stored.
//
// ATLAS_NO_VAULT=true turns resolution and the vault tools off.

import { createInterface } from "node:readline";
import { recordSpend, spendAllowed } from "../skills/site/runtime.js";
import { checkConsent } from "./consent.js";
import { setSecrets } from "./pii-vault.js";

export type VaultEntry =
    | { id: string; label: string; kind: "login"; domains: string[]; username: string; password: string }
    | { id: string; label: string; kind: "api_key"; name: string; value: string; domains: string[] }
    | { id: string; label: string; kind: "card"; holder: string; number: string; expiry: string; brand: string }
    | { id: string; label: string; kind: "upi"; vpa: string };

export const vaultEnabled = () => process.env.ATLAS_NO_VAULT !== "true";

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
const domainsOf = (v: unknown) => (Array.isArray(v) ? v.map(normDomain).filter((d) => d.includes(".")) : []);

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
    syncMasks();
}

/** Every secret value → its token, for pii-vault's masking (plus a pending CVV). */
function syncMasks(): void {
    const m = new Map<string, string>();
    const add = (value: string, id: string, field: string) => {
        // ponytail: values under 4 chars aren't masked (they'd eat ordinary words); a 3-digit CVV is the exception.
        if (value.length >= 4 || field === "cvv") m.set(value, tokenOf(id, field));
    };
    for (const e of entries.values()) {
        for (const [field, value] of fieldsOf(e)) if (field !== "holder" && field !== "expiry") add(value, e.id, field);
    }
    for (const [id, a] of auths) if (a.cvv) add(a.cvv, id, "cvv");
    setSecrets(m);
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
export function listVault(query = ""): VaultListing[] {
    const q = query.trim().toLowerCase();
    const out: VaultListing[] = [];
    for (const e of entries.values()) {
        const domains = "domains" in e ? e.domains : [];
        const hay = [e.id, e.label, ...domains].join(" ").toLowerCase();
        if (q && !q.split(/\s+/).some((w) => hay.includes(w.replace(/^www\./, "")))) continue;
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
const auths = new Map<string, { exp: number; site: string; cvv?: string }>();

const siteOf = (url: string) => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" ? u.hostname.toLowerCase() : "";
    } catch {
        return "";
    }
};
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
    pageUrl: string,
    askCvv: (label: string, item: string, amount: number) => Promise<string | null> = requestCvv,
): Promise<{ ok: true; tokens: string[]; site: string } | { error: string }> {
    if (!vaultEnabled()) return { error: "The vault is turned off (ATLAS_NO_VAULT)." };
    const e = entries.get(entryId);
    if (!e || (e.kind !== "card" && e.kind !== "upi"))
        return { error: `No saved card or UPI ID with id "${entryId}". Call vault_list.` };
    if (!(amount > 0)) return { error: "amount must be the total the owner approved, above 0." };
    const site = siteOf(pageUrl);
    if (!site) return { error: "Open the https payment page in the browser first, then authorize there." };
    if (!spendAllowed(amount))
        return {
            error: "This is over the spend cap (per order or per day). Tell the owner; they can pay it themselves.",
        };
    let cvv: string | undefined;
    if (e.kind === "card") {
        const c = await askCvv(e.label, item, amount);
        if (!c || !/^\d{3,4}$/.test(c))
            return { error: "The owner didn't enter the CVV, so nothing was paid. Ask if they want to try again." };
        cvv = c;
    }
    recordSpend(amount);
    auths.set(entryId, { exp: Date.now() + AUTH_MS, site, cvv });
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
const BROWSER_TYPING = new Set(["browser_type", "browser_keyboard", "site_task"]);

export interface VaultContext {
    isOwner: boolean;
    /** The active browser tab's URL; only called when a browser tool carries a token. */
    pageUrl: () => Promise<string>;
}

const ANY_TOKEN = new RegExp(TOKEN_RE.source); // non-global: no lastIndex state shared with matchAll/replace
export const hasVaultToken = (args: unknown) => ANY_TOKEN.test(JSON.stringify(args ?? ""));

/**
 * Swaps every {{vault:id.field}} in `args` for its value, or refuses the whole
 * call with an error for the model. The result goes to the tool only; the
 * caller keeps the tokens for logs and history.
 */
export async function resolveVaultArgs<T>(
    tool: string,
    args: T,
    ctx: VaultContext,
): Promise<{ args: T } | { error: string }> {
    if (!hasVaultToken(args)) return { args };
    if (!vaultEnabled()) return { error: "The vault is turned off (ATLAS_NO_VAULT), so saved secrets can't be typed." };
    if (!ctx.isOwner) return { error: "Saved secrets can only be used for the owner." };
    if (tool === "browser_multi_action") {
        return {
            error: "Type saved secrets with browser_type, one field per call (a multi-step action could leave the site before it types).",
        };
    }
    const found = [...JSON.stringify(args).matchAll(TOKEN_RE)].map((m) => ({ id: m[1], field: m[2], token: m[0] }));
    const values = new Map<string, string>();
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
            if (inBrowser && host !== a.site) {
                return {
                    error: `${token}: the payment was authorized on ${a.site}, but this page is ${host || "not an https page"}. Refused.`,
                };
            }
            if (field === "cvv") {
                if (!a.cvv)
                    return {
                        error: `${token}: the CVV was already used. Authorize again if the owner wants to retry.`,
                    };
            }
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
        } else desktopAsks.push(`${e.label} ${field}`);
        values.set(token, value);
    }

    if (desktopAsks.length) {
        const { confirmed } = (args ?? {}) as { confirmed?: unknown };
        const key = `vault_desktop:${tool}:${[...values.keys()].sort().join(",")}`;
        if (checkConsent(key, confirmed === true) !== "granted") {
            return {
                error: `Typing ${desktopAsks.join(", ")} into a desktop app needs the owner's OK (no website to check it against). Ask them; only if they say yes, repeat the same call with confirmed: true.`,
            };
        }
        console.log(`  🔐 [vault] owner approved typing ${desktopAsks.join(", ")} via ${tool}`);
    }

    // A CVV is typed once, then forgotten.
    for (const { id, field } of found) {
        const a = auths.get(id);
        if (field === "cvv" && a) a.cvv = undefined;
    }
    if (found.some((f) => f.field === "cvv")) syncMasks();

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
    return { args: swap(args) as T };
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
    if (desktopAttached || process.stdin.isTTY || !process.env.ATLAS_USER_DATA_DIR) return;
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
        }
    } catch {
        /* malformed line */
    }
}

function requestCvv(label: string, item: string, amount: number): Promise<string | null> {
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
        process.stdout.write(`##BHAI_VAULT_CVV##${JSON.stringify({ id, label, item: item.slice(0, 120), amount })}\n`);
    });
}
