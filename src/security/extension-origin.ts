// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// ── Which Chrome extension is Bhai's own ──
// The bridge token (/discover) and the overlay socket used to accept ANY
// chrome-extension:// origin, so any installed extension could act as the owner.
// An extension's WebSocket always carries its browser-set origin, so pinning the
// ID shuts that out. Bhai's extension is loaded unpacked from the folder shipped
// with the app, and Chrome derives an unpacked extension's ID from that folder's
// absolute path — so the ID is computed here, no reinstall or manifest key needed.
// ATLAS_EXTENSION_IDS (comma-separated) adds IDs: a store copy, a dev checkout.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getScriptsDir } from "../config/paths.js";

/** Chrome's ID for an extension loaded unpacked from `dir`: sha256 of the path, first 32 hex digits as a–p. */
export function unpackedExtensionId(dir: string): string {
    const hex = crypto.createHash("sha256").update(dir, "utf8").digest("hex").slice(0, 32);
    return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));
}

/** Where the extension ships: <repo>/chrome-extension in dev, <Resources>/chrome-extension packaged. */
function shippedExtensionDirs(): string[] {
    const scripts = getScriptsDir();
    const dirs = new Set<string>();
    for (const d of [
        path.join(scripts, "..", "chrome-extension"),
        path.join(scripts, "..", "..", "chrome-extension"),
    ]) {
        if (!fs.existsSync(path.join(d, "manifest.json"))) continue;
        dirs.add(path.resolve(d));
        try {
            dirs.add(fs.realpathSync(d)); // Chrome stores the resolved path
        } catch {
            /* keep the resolved one */
        }
    }
    return [...dirs];
}

let allowed: Set<string> | null | undefined;

/** Bhai's extension IDs, or null when they can't be known (then nothing is pinned). */
export function bhaiExtensionIds(): Set<string> | null {
    if (allowed !== undefined) return allowed;
    const ids = new Set(
        (process.env.ATLAS_EXTENSION_IDS ?? "")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => /^[a-p]{32}$/.test(s)),
    );
    // ponytail: Windows hashes the UTF-16 path (case rules unverified), so there only
    // ATLAS_EXTENSION_IDS pins; compute the Windows form once it's checked on a real install.
    if (process.platform !== "win32") for (const d of shippedExtensionDirs()) ids.add(unpackedExtensionId(d));
    allowed = ids.size ? ids : null;
    if (!allowed) console.warn("🔌 Chrome bridge: Bhai's extension ID is unknown — any extension origin is accepted.");
    return allowed;
}

/**
 * A chrome-extension:// origin that isn't Bhai's own. False for every other origin
 * (web origins and no-origin local callers are checked elsewhere).
 */
export function isForeignExtensionOrigin(origin: string | undefined): boolean {
    const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin ?? "");
    if (!origin?.startsWith("chrome-extension://")) return false;
    const ids = bhaiExtensionIds();
    if (!ids) return false;
    const foreign = !m || !ids.has(m[1]);
    // An extension that retries every 2s logged this 525 times in an hour: once per
    // origin per 10 minutes says the same.
    const now = Date.now();
    if (foreign && now - (lastRefusalLog.get(origin) ?? 0) > 10 * 60_000) {
        lastRefusalLog.set(origin, now);
        console.warn(`🔌 Refused extension ${origin} — not Bhai's. If it is yours, add its ID to ATLAS_EXTENSION_IDS.`);
    }
    return foreign;
}
const lastRefusalLog = new Map<string, number>();

/** Tests only: forget the computed IDs. */
export function _resetExtensionIdsForTests(): void {
    allowed = undefined;
}
