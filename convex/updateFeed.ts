// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

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
