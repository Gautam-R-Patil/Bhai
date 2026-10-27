// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Wizard-scoped WhatsApp pairing. Runs Baileys from the Electron main process
// so the user can scan a QR inside the setup wizard BEFORE the bot has booted.
// Writes data/whatsapp-users/owners.json on successful pair so detectWhatsApp
// picks it up on the next detection pass.
"use strict";

const path = require("path");
const fs = require("fs");

// State held across calls (single active pair session at a time).
let _sock = null;
let _listeners = null;

function authStateDir(dataDir) {
    return path.join(dataDir, "whatsapp-users", "baileys-auth-state");
}

function ownersPath(dataDir) {
    return path.join(dataDir, "whatsapp-users", "owners.json");
}

async function recordOwner(dataDir, jid) {
    const file = ownersPath(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }
    if (!Array.isArray(existing)) existing = [];
    // Dedupe on jid
    if (!existing.some((entry) => entry && entry.jid === jid)) {
        existing.unshift({ jid: jid, addedAt: new Date().toISOString() });
    }
    fs.writeFileSync(file, JSON.stringify(existing, null, 2));
    return existing;
}

// startPair accepts a `baileysFactory` so tests can inject a fake. In production
// main.js passes `require("@whiskeysockets/baileys")`. Returns an awaitable that
// resolves when the socket has been created (NOT when the user has paired — the
// caller subscribes to onQr/onConnected).
async function startPair(opts) {
    if (_sock) return { ok: true, alreadyRunning: true };
    const { dataDir, baileysFactory, onQr, onConnected, onError } = opts || {};
    if (!dataDir) throw new Error("startPair: dataDir is required");
    if (!baileysFactory) throw new Error("startPair: baileysFactory is required");
    if (typeof onQr !== "function") throw new Error("startPair: onQr callback is required");
    if (typeof onConnected !== "function") throw new Error("startPair: onConnected callback is required");

    const { default: makeWASocket, useMultiFileAuthState } = baileysFactory;
    if (typeof makeWASocket !== "function" || typeof useMultiFileAuthState !== "function") {
        throw new Error("baileysFactory must expose default+useMultiFileAuthState");
    }

    const auth = await useMultiFileAuthState(authStateDir(dataDir));
    const sock = makeWASocket({
        auth: auth.state,
        printQRInTerminal: false,
        browser: ["Bhai Wizard", "Desktop", "1.0"],
    });
    _sock = sock;
    _listeners = { auth: auth, creds: null, connection: null };

    const onCreds = () => { if (auth.saveCreds) auth.saveCreds(); };
    sock.ev.on("creds.update", onCreds);
    _listeners.creds = onCreds;

    const onConnection = async (update) => {
        if (!update) return;
        if (update.qr) {
            try { onQr(update.qr); } catch { /* renderer gone */ }
        }
        if (update.connection === "open") {
            try {
                const me = sock && sock.user;
                const jid = (me && me.id) ? String(me.id) : "";
                if (jid) await recordOwner(dataDir, jid);
                onConnected(jid);
            } catch (err) {
                if (typeof onError === "function") onError(err.message || String(err));
            }
        }
        if (update.connection === "close") {
            const err = update.lastDisconnect && update.lastDisconnect.error;
            // If user canceled mid-pair, we treat that as error (renderer decides what to do).
            if (typeof onError === "function" && err) onError(err.message || String(err));
        }
    };
    sock.ev.on("connection.update", onConnection);
    _listeners.connection = onConnection;

    return { ok: true };
}

function stopPair() {
    if (!_sock) return { ok: true, notRunning: true };
    try {
        if (_listeners) {
            if (_listeners.creds) { try { _sock.ev.off("creds.update", _listeners.creds); } catch {} }
            if (_listeners.connection) { try { _sock.ev.off("connection.update", _listeners.connection); } catch {} }
        }
        try { if (typeof _sock.end === "function") _sock.end(); } catch {}
        try { if (typeof _sock.logout === "function") _sock.logout(); } catch {}
    } finally {
        _sock = null;
        _listeners = null;
    }
    return { ok: true };
}

function isPairing() { return _sock !== null; }

// For tests — reset internal state without needing a real sock.
function _resetForTests() {
    _sock = null;
    _listeners = null;
}

module.exports = { startPair, stopPair, isPairing, recordOwner, authStateDir, ownersPath, _resetForTests };
