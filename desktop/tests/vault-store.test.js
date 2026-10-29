// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readVault, registerVaultIpc, writeVault } from "../vault-store.js";

// safeStorage stand-in: a reversible transform that is visibly not plaintext.
const safeStorage = {
    available: true,
    isEncryptionAvailable() {
        return this.available;
    },
    encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString("base64").split("").reverse().join("")}`),
    decryptString: (b) => Buffer.from(b.toString().slice(4).split("").reverse().join(""), "base64").toString(),
};

const PASSWORD = "Hunter2-zomato!";
const LOGIN = {
    kind: "login",
    label: "Zomato",
    domains: "https://www.zomato.com/login",
    username: "me@example.com",
    password: PASSWORD,
};
const CARD = {
    kind: "card",
    label: "HDFC",
    holder: "D S",
    number: "4111 1111 1111 1111",
    expiry: "12/29",
    brand: "visa",
    cvv: "321",
};

function setup({ canTouchId = true, touchOk = true, now } = {}) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")), "vault.enc");
    const handlers = {};
    const sent = [];
    const prompts = { n: 0 };
    const main = { id: "main" };
    registerVaultIpc({
        ipcMain: {
            handle: (ch, fn) => {
                handlers[ch] = fn;
            },
        },
        safeStorage,
        file,
        trusted: (evt) => evt.sender === main,
        canTouchId: () => canTouchId,
        promptTouchId: () => {
            prompts.n++;
            return touchOk ? Promise.resolve() : Promise.reject(new Error("cancelled"));
        },
        ...(now ? { now } : {}),
        onChange: (entries) => sent.push(entries),
    });
    const call = (ch, ...args) => handlers[ch]({ sender: main }, ...args);
    const callAs = (sender, ch, ...args) => handlers[ch]({ sender }, ...args);
    return { file, call, callAs, sent, prompts };
}

beforeEach(() => {
    safeStorage.available = true;
});

describe("vault store: encrypted at rest", () => {
    it("round-trips through safeStorage and never writes a value in plaintext", () => {
        const { file } = setup();
        writeVault(file, safeStorage, { entries: [{ id: "a", label: "x", kind: "login", password: PASSWORD }] });
        expect(fs.readFileSync(file, "utf8")).not.toContain(PASSWORD);
        expect(readVault(file, safeStorage).entries[0].password).toBe(PASSWORD);
    });

    it("refuses to save when OS encryption is unavailable", async () => {
        const { file, call } = setup();
        safeStorage.available = false;
        expect(await call("vault:save", LOGIN)).toMatchObject({ success: false });
        expect(fs.existsSync(file)).toBe(false);
    });

    it("never stores a CVV, and the bot gets the full list", async () => {
        const { file, call, sent } = setup();
        await call("vault:save", CARD);
        expect(JSON.stringify(readVault(file, safeStorage))).not.toContain("321");
        expect(sent.at(-1)[0]).toMatchObject({ kind: "card", number: "4111111111111111" });
        expect(sent.at(-1)[0]).not.toHaveProperty("cvv");
    });
});

describe("vault IPC: the renderer can't read raw secrets", () => {
    it("list returns the masked view only", async () => {
        const { call } = setup();
        await call("vault:save", LOGIN);
        await call("vault:save", CARD);
        const r = await call("vault:list");
        const out = JSON.stringify(r);
        for (const v of [PASSWORD, "me@example.com", "4111 1111 1111 1111", "4111111111111111"])
            expect(out).not.toContain(v);
        expect(r.entries[0]).toMatchObject({
            label: "Zomato",
            domains: ["zomato.com"],
            username_masked: "m***@example.com",
        });
        expect(r.entries[1].last4).toBe("1111");
    });

    it("reveal needs Touch ID, and only the main window may ask", async () => {
        const denied = setup({ touchOk: false });
        await denied.call("vault:save", LOGIN);
        const id = (await denied.call("vault:list")).entries[0].id;
        expect(await denied.call("vault:reveal", id)).toEqual({ success: false, error: "auth_failed" });

        const ok = setup();
        await ok.call("vault:save", LOGIN);
        const id2 = (await ok.call("vault:list")).entries[0].id;
        expect(await ok.callAs({ id: "overlay" }, "vault:reveal", id2)).toEqual({
            success: false,
            error: "Not allowed",
        });
        expect(await ok.callAs({ id: "overlay" }, "vault:list")).toEqual({ success: false, error: "Not allowed" });
        expect((await ok.call("vault:reveal", id2)).values.password).toBe(PASSWORD);
    });

    it("without Touch ID: the vault password gates reveal and edits", async () => {
        const { call } = setup({ canTouchId: false });
        await call("vault:save", LOGIN);
        const id = (await call("vault:list")).entries[0].id;
        expect(await call("vault:reveal", id, "anything")).toMatchObject({ success: false }); // no password set yet
        expect(await call("vault:set-password", "correct horse")).toEqual({ success: true });
        expect(await call("vault:set-password", "new one!", "wrong")).toMatchObject({ success: false });
        expect(await call("vault:reveal", id, "wrong")).toMatchObject({ success: false, error: "auth_failed" });
        // Re-pointing a login at another site is gated like viewing it.
        expect(
            await call(
                "vault:save",
                { id, label: "Zomato", domains: "evil.com", username: "me@example.com", password: "" },
                "wrong",
            ),
        ).toMatchObject({ success: false });
        const r = await call(
            "vault:save",
            { id, label: "Zomato", domains: "zomato.com", username: "me@example.com", password: "" },
            "correct horse",
        );
        expect(r.success).toBe(true);
        expect((await call("vault:reveal", id, "correct horse")).values.password).toBe(PASSWORD); // blank kept the old one
    });

    it("delete needs Touch ID (or the vault password) like viewing", async () => {
        const denied = setup({ touchOk: false });
        await denied.call("vault:save", LOGIN);
        const id = (await denied.call("vault:list")).entries[0].id;
        expect(await denied.call("vault:delete", id)).toEqual({ success: false, error: "auth_failed" });
        expect((await denied.call("vault:list")).entries).toHaveLength(1);

        const pw = setup({ canTouchId: false });
        await pw.call("vault:save", LOGIN);
        await pw.call("vault:set-password", "correct horse");
        const id2 = (await pw.call("vault:list")).entries[0].id;
        expect(await pw.call("vault:delete", id2, "wrong")).toMatchObject({ success: false, error: "auth_failed" });
        expect((await pw.call("vault:delete", id2, "correct horse")).entries).toHaveLength(0);
    });

    it("one Touch ID covers that entry for a minute: Edit (load + save) asks once", async () => {
        let t = 1_000_000;
        const { call, prompts } = setup({ now: () => t });
        await call("vault:save", LOGIN);
        await call("vault:save", CARD);
        const [login, card] = (await call("vault:list")).entries;
        await call("vault:reveal", login.id);
        await call("vault:save", {
            id: login.id,
            label: "Zomato 2",
            domains: "zomato.com",
            username: "me@example.com",
            password: "",
        });
        expect(prompts.n).toBe(1);
        await call("vault:reveal", card.id); // another entry: asks again
        expect(prompts.n).toBe(2);
        t += 61_000; // the minute is up
        await call("vault:reveal", login.id);
        expect(prompts.n).toBe(3);
    });

    it("a login must name its website", async () => {
        const { call } = setup();
        expect(await call("vault:save", { ...LOGIN, domains: "" })).toMatchObject({ success: false });
    });
});
