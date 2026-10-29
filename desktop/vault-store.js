// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The owner's Vault (logins, API keys, cards, UPI IDs) on disk: one file,
// vault.enc in userData, encrypted with Electron safeStorage (Keychain on
// macOS, DPAPI/Credential Manager on Windows). Never written in plaintext:
// with no OS encryption available, saving fails.
//
// The renderer only ever gets the masked view. A raw value goes out only for
// "show" after Touch ID (or the vault password where Touch ID isn't available),
// and only to the main window. The decrypted list goes to the bot over its
// stdin pipe (main.js), never to Convex. A CVV is never stored: unknown fields
// (cvv included) are dropped on save.
//
// No Electron imports here: main.js passes safeStorage/ipcMain in (testable).

const fs = require("node:fs");
const crypto = require("node:crypto");

const FIELDS = {
    login: ["username", "password"],
    api_key: ["name", "value"],
    card: ["holder", "number", "expiry", "brand"],
    upi: ["vpa"],
};
// Kept when an edit leaves them blank (the renderer never has them).
const SECRET = { login: ["password"], api_key: ["value"], card: ["number"], upi: [] };

function readVault(file, safeStorage) {
    if (!fs.existsSync(file)) return { entries: [] };
    const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    return { entries: Array.isArray(data.entries) ? data.entries : [], pw: data.pw };
}

function writeVault(file, safeStorage, vault) {
    if (!safeStorage.isEncryptionAvailable())
        throw new Error("OS encryption isn't available, so the vault can't be saved safely.");
    const buf = safeStorage.encryptString(JSON.stringify({ v: 1, entries: vault.entries, pw: vault.pw }));
    fs.writeFileSync(`${file}.tmp`, buf, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file); // atomic: a crash never leaves half a vault
}

const s = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const normDomain = (d) =>
    s(d, 253)
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/[/:?#].*$/, "")
        .replace(/^www\./, "");

/** Validates an entry from the renderer. `prev` is the stored entry when editing. */
function sanitizeEntry(raw, prev) {
    const r = raw || {};
    const kind = prev ? prev.kind : r.kind;
    if (!FIELDS[kind]) throw new Error("Unknown entry type");
    const label = s(r.label, 80);
    if (!label) throw new Error("Give it a name");
    const id = prev
        ? prev.id
        : `${
              label
                  .toLowerCase()
                  .replace(/[^a-z]+/g, "_")
                  .replace(/^_|_$/g, "")
                  .slice(0, 24) || "entry"
          }_${randomLetters(4)}`;
    const e = { id, label, kind };
    for (const f of FIELDS[kind]) {
        e[f] = s(r[f]);
        if (!e[f] && prev && SECRET[kind].includes(f)) e[f] = prev[f];
    }
    if (kind === "login" || kind === "api_key") {
        e.domains = (Array.isArray(r.domains) ? r.domains : String(r.domains || "").split(/[\s,]+/))
            .map(normDomain)
            .filter((d) => d.includes("."));
        if (kind === "login" && !e.domains.length)
            throw new Error("Add the website (e.g. zomato.com): Bhai only types this login there");
        if (kind === "login" && !e.password) throw new Error("Password is missing");
    }
    if (kind === "card") {
        const digits = e.number.replace(/\D/g, "");
        if (digits.length < 12 || digits.length > 19 || /[^\d\s-]/.test(e.number))
            throw new Error("Card number doesn't look right");
        e.number = digits;
        if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(e.expiry)) throw new Error("Expiry should be MM/YY");
    }
    if (kind === "upi" && !/^[\w.-]{2,}@[a-z][a-z0-9]{1,}$/i.test(e.vpa))
        throw new Error("UPI ID should look like name@bank");
    if (kind === "api_key" && !e.value) throw new Error("Key is missing");
    return e; // only the listed fields: a cvv (or anything else) is never kept
}

function randomLetters(n) {
    return Array.from(crypto.randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join("");
}

const maskName = (u) => {
    if (!u) return "";
    const at = u.indexOf("@");
    return at > 0 ? `${u[0]}***${u.slice(at)}` : `${u[0]}***`;
};

/** What the renderer may see: no password, key, card number or full UPI ID. */
function publicView(entries) {
    return entries.map((e) => ({
        id: e.id,
        label: e.label,
        kind: e.kind,
        domains: e.domains || [],
        username_masked: e.kind === "login" ? maskName(e.username) : e.kind === "upi" ? maskName(e.vpa) : undefined,
        name: e.kind === "api_key" ? e.name : undefined,
        last4: e.kind === "card" ? e.number.slice(-4) : undefined,
        brand: e.kind === "card" ? e.brand : undefined,
        expiry: e.kind === "card" ? e.expiry : undefined,
    }));
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
    return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPassword(pw, stored) {
    if (!stored || typeof pw !== "string") return false;
    const [salt, hash] = stored.split(":");
    const got = crypto.scryptSync(pw, salt, 32);
    const want = Buffer.from(hash, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * IPC for Settings → Vault.
 *   trusted(evt)         → only the main window may call these
 *   canTouchId()         → boolean: this Mac can prompt Touch ID
 *   promptTouchId(why)   → Promise<boolean>: the owner passed it
 *   onChange(entries)    → the full decrypted list, for the bot
 */
function registerVaultIpc({ ipcMain, safeStorage, file, trusted, canTouchId, promptTouchId, onChange }) {
    const load = () => readVault(file, safeStorage);
    const save = (vault) => {
        writeVault(file, safeStorage, vault);
        onChange(vault.entries);
        return { success: true, entries: publicView(vault.entries) };
    };
    // Touch ID where the Mac has it; else the vault password (set on first use).
    const authenticate = async (vault, password, reason) => {
        if (canTouchId())
            return promptTouchId(reason).then(
                () => true,
                () => false,
            );
        return checkPassword(password, vault.pw);
    };
    const guard =
        (fn) =>
        async (evt, ...args) => {
            if (!trusted(evt)) return { success: false, error: "Not allowed" };
            try {
                return await fn(...args);
            } catch (e) {
                return { success: false, error: e.message };
            }
        };

    ipcMain.handle(
        "vault:list",
        guard(async () => {
            const vault = load();
            return {
                success: true,
                entries: publicView(vault.entries),
                touchId: canTouchId(),
                hasPassword: !!vault.pw,
            };
        }),
    );
    ipcMain.handle(
        "vault:set-password",
        guard(async (password, oldPassword) => {
            const vault = load();
            if (vault.pw && !checkPassword(oldPassword, vault.pw))
                return { success: false, error: "Current vault password is wrong" };
            if (typeof password !== "string" || password.length < 6)
                return { success: false, error: "Use at least 6 characters" };
            vault.pw = hashPassword(password);
            writeVault(file, safeStorage, vault);
            return { success: true };
        }),
    );
    ipcMain.handle(
        "vault:save",
        guard(async (entry, password) => {
            const vault = load();
            const i = entry?.id ? vault.entries.findIndex((e) => e.id === entry.id) : -1;
            if (entry?.id && i < 0) return { success: false, error: "That entry no longer exists" };
            // Editing can point a login at another website: same check as viewing it.
            if (i >= 0 && !(await authenticate(vault, password, `change "${vault.entries[i].label}" in your vault`))) {
                return { success: false, error: "auth_failed" };
            }
            const e = sanitizeEntry(entry, i >= 0 ? vault.entries[i] : null);
            if (i >= 0) vault.entries[i] = e;
            else vault.entries.push(e);
            return save(vault);
        }),
    );
    ipcMain.handle(
        "vault:delete",
        guard(async (id, password) => {
            const vault = load();
            const e = vault.entries.find((x) => x.id === id);
            if (!e) return { success: false, error: "That entry no longer exists" };
            // Gated like viewing or editing it: the Touch ID prompt is also the "are you sure".
            if (!(await authenticate(vault, password, `delete "${e.label}" from your vault`)))
                return { success: false, error: "auth_failed" };
            vault.entries = vault.entries.filter((x) => x.id !== id);
            return save(vault);
        }),
    );
    ipcMain.handle(
        "vault:reveal",
        guard(async (id, password) => {
            const vault = load();
            const e = vault.entries.find((x) => x.id === id);
            if (!e) return { success: false, error: "Not found" };
            if (!(await authenticate(vault, password, `show "${e.label}" from your vault`)))
                return { success: false, error: "auth_failed" };
            const out = {};
            for (const f of FIELDS[e.kind]) out[f] = e[f];
            return { success: true, values: out };
        }),
    );
    return { load };
}

module.exports = { readVault, writeVault, sanitizeEntry, publicView, registerVaultIpc, hashPassword, checkPassword };
