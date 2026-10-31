// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Sites the panel and wizard link out to ("Create a GitHub token", "Open @BotFather", ...).
// A target=_blank link to one of these opens in the default browser; nothing opens in-app.
const PANEL_LINK_HOSTS = new Set([
    "github.com", "t.me", "telegram.me", "discord.com", "api.slack.com", "slack.com", "wa.me", "api.whatsapp.com",
    "myaccount.google.com", "appleid.apple.com", "login.yahoo.com", "matrix.org",
    "tryatlasagi.com", "www.tryatlasagi.com", "xagilab.com", "www.xagilab.com",
]);

/** The URL to hand to the OS browser, or null when the link isn't one of ours. */
function panelLinkTarget(url) {
    try {
        const u = new URL(url);
        if (u.protocol === "mailto:") return u.href;
        if (u.protocol !== "https:" || u.username || u.password) return null;
        return PANEL_LINK_HOSTS.has(u.hostname.toLowerCase()) ? u.href : null;
    } catch {
        return null;
    }
}

/** A link in a chat reply (any web page): the URL to hand to the OS browser, or null. */
function chatLinkTarget(url) {
    try {
        const u = new URL(url);
        if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
        return u.href;
    } catch {
        return null;
    }
}

module.exports = { panelLinkTarget, chatLinkTarget };
