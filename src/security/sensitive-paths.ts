// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Sensitive-path deny-list ───────────────────────────
// Tools that read user data and surface it to the LLM context must
// refuse a fixed set of paths that almost always contain credentials:
// API keys, SSH keys, browser credentials, Bhai internal state, etc.
//
// The check is symlink-aware via realResolve — a symlink in a
// non-sensitive dir pointing at /etc/passwd is treated as /etc/passwd.
// `~` expansion, NFC normalisation, and case-folding (on darwin/win32)
// keep the deny-list robust against trivial bypasses.

import os from "node:os";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { realResolve } from "./allowlist.js";

const HOME = os.homedir();
const IS_CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

function normalize(p: string): string {
    let expanded = p;
    if (expanded.startsWith("~/") || expanded === "~") {
        expanded = path.join(HOME, expanded.slice(1));
    }
    const abs = path.resolve(expanded);
    const real = realResolve(abs);
    const nfc = real.normalize("NFC");
    return IS_CASE_INSENSITIVE_FS ? nfc.toLowerCase() : nfc;
}

function eq(a: string, b: string): boolean {
    return IS_CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function startsWith(a: string, b: string): boolean {
    return IS_CASE_INSENSITIVE_FS ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b);
}

// Exact-file deny list. Each entry is resolved + normalized lazily.
function exactDeniedPaths(): string[] {
    return [
        path.join(HOME, ".netrc"),
        path.join(HOME, ".npmrc"),
        path.join(HOME, ".git-credentials"),
        path.join(HOME, ".bash_history"),
        path.join(HOME, ".zsh_history"),
        path.join(HOME, ".docker", "config.json"),
        path.join(HOME, ".kube", "config"),
        path.join(getDataDir(), "google-credentials.json"),
        path.join(getDataDir(), "chrome-bridge-token.txt"),
        path.join(getDataDir(), "audit.jsonl"),
        path.join(getDataDir(), "memories.db"),
    ];
}

// Prefix deny list — anything under these dirs is denied.
function deniedDirPrefixes(): string[] {
    return [
        path.join(HOME, ".ssh"),
        path.join(HOME, ".aws"),
        path.join(HOME, ".gnupg"),
        path.join(HOME, ".atlas"),
        path.join(getDataDir(), "google-tokens"),
    ];
}

// Filename + extension patterns. Case-insensitive everywhere.
const FILENAME_PATTERNS: RegExp[] = [
    /^\.env$/i,
    /^\.env\..+$/i,
    // *.env / *.env.local / *.env.production — common env-file shapes.
    /\.env(\.[a-zA-Z0-9_-]+)?$/i,
    /\.pem$/i,
    /\.p12$/i,
    /private[_-]?key/i,
    /id_rsa(\.pub)?$/i,
    /id_ed25519(\.pub)?$/i,
    /^\.aws[_-]?credentials/i,
];

export interface SensitivePathCheck {
    denied: boolean;
    reason?: string;
}

/**
 * Returns { denied: true, reason } if the path matches a known
 * sensitive location. Resolves symlinks, expands ~, NFC-normalises,
 * and is case-insensitive on darwin/win32.
 */
export function isSensitivePath(inputPath: string): SensitivePathCheck {
    if (!inputPath) return { denied: false };
    const resolved = normalize(inputPath);
    const base = path.basename(resolved);
    // NTFS alternate data streams (".env::$DATA") read the same bytes but dodge
    // the name patterns below; a colon past the drive letter is never a file name.
    if (process.platform === "win32" && resolved.indexOf(":", 2) !== -1) {
        return { denied: true, reason: `Path "${inputPath}" names an NTFS data stream.` };
    }

    for (const pattern of FILENAME_PATTERNS) {
        if (pattern.test(base)) {
            return { denied: true, reason: `Path "${inputPath}" matches sensitive filename pattern ${pattern}.` };
        }
    }

    for (const exact of exactDeniedPaths()) {
        const ne = normalize(exact);
        if (eq(resolved, ne)) {
            return { denied: true, reason: `Path "${inputPath}" is a known sensitive file (${exact}).` };
        }
    }

    for (const prefix of deniedDirPrefixes()) {
        const np = normalize(prefix);
        if (eq(resolved, np) || startsWith(resolved, np + path.sep)) {
            return { denied: true, reason: `Path "${inputPath}" is inside a sensitive directory (${prefix}).` };
        }
    }

    return { denied: false };
}
