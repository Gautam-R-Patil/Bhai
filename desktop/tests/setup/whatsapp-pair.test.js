// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
    startPair,
    stopPair,
    isPairing,
    recordOwner,
    ownersPath,
    _resetForTests,
} from "../../setup/whatsapp-pair.js";

function fakeSock() {
    const listeners = { "creds.update": [], "connection.update": [] };
    return {
        user: { id: "919999999999@s.whatsapp.net" },
        ev: {
            on: (event, handler) => { listeners[event].push(handler); },
            off: (event, handler) => {
                listeners[event] = listeners[event].filter((h) => h !== handler);
            },
            emit: (event, payload) => {
                for (const h of listeners[event].slice()) h(payload);
            },
        },
        end: () => {},
        logout: () => {},
        _listeners: listeners,
    };
}

function fakeBaileys(sock, authState) {
    return {
        default: () => sock,
        useMultiFileAuthState: async () => ({ state: authState || {}, saveCreds: () => {} }),
    };
}

let tmp;
beforeEach(() => {
    _resetForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-wa-pair-"));
});
afterEach(() => { _resetForTests(); });

describe("recordOwner", () => {
    it("creates owners.json with the JID on first call", async () => {
        await recordOwner(tmp, "919876543210@s.whatsapp.net");
        const owners = JSON.parse(fs.readFileSync(ownersPath(tmp), "utf8"));
        expect(owners).toHaveLength(1);
        expect(owners[0].jid).toBe("919876543210@s.whatsapp.net");
        expect(typeof owners[0].addedAt).toBe("string");
    });
    it("deduplicates on repeated calls with the same JID", async () => {
        await recordOwner(tmp, "a@s.whatsapp.net");
        await recordOwner(tmp, "a@s.whatsapp.net");
        const owners = JSON.parse(fs.readFileSync(ownersPath(tmp), "utf8"));
        expect(owners).toHaveLength(1);
    });
    it("prepends a second distinct JID", async () => {
        await recordOwner(tmp, "a@s.whatsapp.net");
        await recordOwner(tmp, "b@s.whatsapp.net");
        const owners = JSON.parse(fs.readFileSync(ownersPath(tmp), "utf8"));
        expect(owners.map((o) => o.jid)).toEqual(["b@s.whatsapp.net", "a@s.whatsapp.net"]);
    });
    it("repairs corrupt owners.json (non-array)", async () => {
        fs.mkdirSync(path.dirname(ownersPath(tmp)), { recursive: true });
        fs.writeFileSync(ownersPath(tmp), "not json");
        await recordOwner(tmp, "c@s.whatsapp.net");
        const owners = JSON.parse(fs.readFileSync(ownersPath(tmp), "utf8"));
        expect(owners.map((o) => o.jid)).toEqual(["c@s.whatsapp.net"]);
    });
});

describe("startPair / stopPair", () => {
    it("requires dataDir, baileysFactory, onQr, onConnected", async () => {
        await expect(startPair({})).rejects.toThrow(/dataDir/);
        await expect(startPair({ dataDir: tmp })).rejects.toThrow(/baileysFactory/);
        await expect(startPair({ dataDir: tmp, baileysFactory: fakeBaileys(fakeSock()) })).rejects.toThrow(/onQr/);
        await expect(startPair({ dataDir: tmp, baileysFactory: fakeBaileys(fakeSock()), onQr: () => {} })).rejects.toThrow(/onConnected/);
    });

    it("rejects a baileysFactory without default + useMultiFileAuthState", async () => {
        await expect(
            startPair({ dataDir: tmp, baileysFactory: {}, onQr: () => {}, onConnected: () => {} })
        ).rejects.toThrow(/baileysFactory must expose/);
    });

    it("emits QR strings via onQr as Baileys raises them", async () => {
        const qrs = [];
        const sock = fakeSock();
        await startPair({
            dataDir: tmp,
            baileysFactory: fakeBaileys(sock),
            onQr: (q) => qrs.push(q),
            onConnected: () => {},
        });
        sock.ev.emit("connection.update", { qr: "qr-string-1" });
        sock.ev.emit("connection.update", { qr: "qr-string-2" });
        expect(qrs).toEqual(["qr-string-1", "qr-string-2"]);
    });

    it("calls onConnected with the JID when connection opens, and writes owners.json", async () => {
        const sock = fakeSock();
        let seen = null;
        await startPair({
            dataDir: tmp,
            baileysFactory: fakeBaileys(sock),
            onQr: () => {},
            onConnected: (jid) => { seen = jid; },
        });
        sock.ev.emit("connection.update", { connection: "open" });
        // Let the async recordOwner inside the handler resolve.
        await new Promise((r) => setTimeout(r, 5));
        expect(seen).toBe("919999999999@s.whatsapp.net");
        const owners = JSON.parse(fs.readFileSync(ownersPath(tmp), "utf8"));
        expect(owners[0].jid).toBe("919999999999@s.whatsapp.net");
    });

    it("is idempotent: second startPair while one is running is a no-op", async () => {
        const sock = fakeSock();
        await startPair({
            dataDir: tmp,
            baileysFactory: fakeBaileys(sock),
            onQr: () => {},
            onConnected: () => {},
        });
        expect(isPairing()).toBe(true);
        const second = await startPair({
            dataDir: tmp,
            baileysFactory: fakeBaileys(fakeSock()),
            onQr: () => {},
            onConnected: () => {},
        });
        expect(second).toEqual({ ok: true, alreadyRunning: true });
    });

    it("stopPair detaches listeners + clears state", async () => {
        const sock = fakeSock();
        await startPair({
            dataDir: tmp,
            baileysFactory: fakeBaileys(sock),
            onQr: () => {},
            onConnected: () => {},
        });
        expect(sock._listeners["connection.update"].length).toBe(1);
        expect(sock._listeners["creds.update"].length).toBe(1);
        stopPair();
        expect(sock._listeners["connection.update"].length).toBe(0);
        expect(sock._listeners["creds.update"].length).toBe(0);
        expect(isPairing()).toBe(false);
    });

    it("stopPair is safe to call when nothing is running", () => {
        const res = stopPair();
        expect(res).toEqual({ ok: true, notRunning: true });
    });

    it("forwards connection.close errors to onError", async () => {
        const sock = fakeSock();
        const errs = [];
        await startPair({
            dataDir: tmp,
            baileysFactory: fakeBaileys(sock),
            onQr: () => {},
            onConnected: () => {},
            onError: (m) => errs.push(m),
        });
        sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Error("user canceled") } });
        expect(errs).toEqual(["user canceled"]);
    });
});
