// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Whether a "##BHAI_NOTIFY##" line from the bot (src/desktop-notify.ts) becomes
// a native notification. "done" and "proactive" are skipped while a Bhai window
// is in front (the owner already sees it); a reminder the owner asked for, and
// "stuck"/"handoff" (Bhai waits on the owner), always show unless notifications
// are off altogether.

const PREF = { done: "notifyOnTask", proactive: "notifyOnMessage", reminder: null, stuck: null, handoff: null };
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

module.exports = { createNotifyGate };
