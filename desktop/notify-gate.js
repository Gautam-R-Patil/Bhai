// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Whether a "##BHAI_NOTIFY##" line from the bot (src/desktop-notify.ts) becomes
// a native notification. "done", "proactive" and "inbox" are skipped while a
// Bhai window is in front (the owner already sees it); a reminder the owner asked
// for, and "stuck"/"waiting"/"handoff" (Bhai waits on the owner), always show
// unless notifications are off altogether.

const PREF = {
    done: "notifyOnTask",
    proactive: "notifyOnMessage",
    inbox: "notifyOnMessage",
    reminder: null,
    stuck: null,
    waiting: null,
    handoff: null,
};
const REPEAT_MS = 10_000;

function createNotifyGate(getPref) {
    let last = { body: "", at: 0 };
    return function shouldNotify({ kind, body }, bhaiFocused, now = Date.now()) {
        if (!Object.hasOwn(PREF, kind) || !body || getPref("notificationsEnabled") === false) return false;
        const pref = PREF[kind];
        if (pref && (getPref(pref) === false || bhaiFocused)) return false;
        // Research completion reaches the bot by two paths; one notification is enough.
        if (body === last.body && now - last.at < REPEAT_MS) return false;
        last = { body, at: now };
        return true;
    };
}

// What a notification button does, from the bot's description of it: say a
// message in chat, or send an inbox decision. Anything else does nothing.
function actionToSend(a) {
    if (a && typeof a.message === "string" && a.message.trim()) return { text: a.message.slice(0, 500) };
    const ws = a && a.ws;
    if (ws && /^inbox:(approve|reject)$/.test(ws.type) && typeof ws.id === "string") return { raw: { type: ws.type, id: ws.id.slice(0, 100) } };
    return null;
}

module.exports = { createNotifyGate, actionToSend };
