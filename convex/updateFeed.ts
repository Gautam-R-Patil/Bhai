// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// The electron-updater feed served under /api/updates/ (env vars documented in http.ts).

const FEED_FILE = /^\/api\/updates\/(latest|stable|beta|alpha|canary)(-mac)?\.yml$/;

/**
 * Which update feed a GET under /api/updates/ asks for. electron-updater requests
 * `<channel>-mac.yml` (macOS) or `<channel>.yml` (Windows) once the app sets
 * autoUpdater.channel, which the desktop always does, and `latest*.yml` without one
 * (channel null: the caller reads ?channel=). Null for anything else.
 */
export function parseUpdateFeedPath(pathname: string): { platform: "mac" | "win"; channel: string | null } | null {
    const m = FEED_FILE.exec(pathname);
    if (!m) return null;
    return { platform: m[2] ? "mac" : "win", channel: m[1] === "latest" ? null : m[1] };
}

function yamlHeaders(): Record<string, string> {
    return {
        "Content-Type": "text/yaml; charset=utf-8",
        // Cache for 2 minutes at the edge so a thundering-herd recheck doesn't
        // hammer the backend. Clients can still bypass via ?t=<timestamp>.
        "Cache-Control": "public, max-age=120",
    };
}

function pickChannel(url: URL): string {
    const ch = (url.searchParams.get("channel") || "stable").toLowerCase();
    // Only allow a small whitelist — env var names must be predictable.
    return ch === "beta" || ch === "alpha" || ch === "canary" ? ch : "stable";
}

function envForChannel(name: string, channel: string): string | undefined {
    if (channel && channel !== "stable") {
        const v = process.env[`${name}_${channel.toUpperCase()}`];
        if (v) return v;
    }
    return process.env[name];
}

// Channels in descending stability order. When the client asks for a
// channel that hasn't been provisioned yet, we fall back to the most-stable
// channel that IS provisioned. So while only alpha exists, every client —
// stable, beta, alpha — gets the alpha yml. As soon as beta env vars are
// set, stable+beta clients flip to beta and alpha clients keep their own.
const CHANNEL_STABILITY: readonly string[] = ["stable", "beta", "alpha"];

function resolveChannelWithFallback(platform: "mac" | "win", requested: string): string {
    const P = platform.toUpperCase();
    const probe = (ch: string) => !!envForChannel("UPDATE_VERSION", ch) && !!envForChannel(`UPDATE_URL_${P}`, ch);
    if (probe(requested)) return requested;
    // The requested channel has no artifacts — find a substitute. Walk
    // toward less-stable channels first (so when only alpha is provisioned,
    // a "stable" client gets alpha instead of nothing); then walk back
    // toward more-stable channels as a last resort.
    const startIdx = CHANNEL_STABILITY.indexOf(requested);
    if (startIdx >= 0) {
        for (let i = startIdx + 1; i < CHANNEL_STABILITY.length; i++) {
            if (probe(CHANNEL_STABILITY[i])) return CHANNEL_STABILITY[i];
        }
        for (let i = startIdx - 1; i >= 0; i--) {
            if (probe(CHANNEL_STABILITY[i])) return CHANNEL_STABILITY[i];
        }
    } else {
        for (const ch of CHANNEL_STABILITY) if (probe(ch)) return ch;
    }
    return requested; // nothing provisioned — the feed answers 404
}

/** The feed's yml, or null when nothing is published for this platform (or this Mac's arch). */
function buildYaml(platform: "mac" | "win", requested: string, intelMac: boolean): string | null {
    const P = platform.toUpperCase(); // MAC | WIN
    const channel = resolveChannelWithFallback(platform, requested);

    const version = envForChannel("UPDATE_VERSION", channel);
    const url = envForChannel(`UPDATE_URL_${P}`, channel);
    if (!version || !url) return null;

    const sha512 = envForChannel(`UPDATE_SHA512_${P}`, channel) || "";
    const size = Number(envForChannel(`UPDATE_SIZE_${P}`, channel) || 0) || 0;
    const mirror = envForChannel(`UPDATE_URL_${P}_MIRROR`, channel);
    const releaseDate = envForChannel("UPDATE_RELEASE_DATE", channel) || new Date().toISOString();
    const files = [{ url, sha512, size }];
    if (mirror) files.push({ url: mirror, sha512, size });
    if (platform === "mac") {
        // The Intel zip comes from the same channel suffix as the main URL, never another channel's release.
        const C =
            channel !== "stable" && process.env[`UPDATE_URL_MAC_${channel.toUpperCase()}`]
                ? `_${channel.toUpperCase()}`
                : "";
        const x64 = process.env[`UPDATE_URL_MAC_X64${C}`];
        if (x64) {
            files.push({
                url: x64,
                sha512: process.env[`UPDATE_SHA512_MAC_X64${C}`] || "",
                size: Number(process.env[`UPDATE_SIZE_MAC_X64${C}`] || 0) || 0,
            });
        }
        // MacUpdater never installs a URL with "arm64" on an Intel Mac: offering one is a banner
        // that ends in "ZIP file not provided".
        if (intelMac && files.every((f) => f.url.includes("arm64"))) return null;
    }

    // electron-updater picks the first `files:` entry it can install (by arch on a Mac).
    // Top-level path/sha512 kept for v5 compat.
    const lines = [`version: ${version}`, "files:"];
    for (const f of files) lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
    lines.push(`path: ${url.split("/").pop()}`, `sha512: ${sha512}`, `releaseDate: ${releaseDate}`);
    return `${lines.join("\n")}\n`;
}

/**
 * GET /api/updates/<file>.yml. A feed with nothing published answers 404, which the desktop
 * reads as "nothing published": a 200 placeholder (version 0.0.0) would read as an update,
 * since setting autoUpdater.channel also turns on allowDowngrade.
 */
export function updateFeedResponse(request: Request): Response {
    const url = new URL(request.url);
    const feed = parseUpdateFeedPath(url.pathname);
    const body =
        feed && buildYaml(feed.platform, feed.channel ?? pickChannel(url), url.searchParams.get("arch") === "x64");
    if (!body) return new Response("Not found", { status: 404 });
    return new Response(body, { status: 200, headers: yamlHeaders() });
}
