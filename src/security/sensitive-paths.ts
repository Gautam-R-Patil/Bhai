// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
import { getBhaiHome, getDataDir } from "../config/paths.js";
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
    ];
}

// Inside the data dir, only these are the model's to read: saved tool outputs (masked),
// research reports, video projects, coders' worktrees (BHAI_AGENT_WORKTREE) and background
// commands' logs (shell_exec_background hands out their log_file). Everything else there is
// Bhai's state.
const READABLE_DATA_SUBDIRS = ["tool-outputs", "research", "video-projects", "agent-worktrees", "process-logs"];

// Prefix deny list — anything under these dirs is denied.
function deniedDirPrefixes(): string[] {
    return [
        path.join(HOME, ".ssh"),
        path.join(HOME, ".aws"),
        path.join(HOME, ".gnupg"),
        path.join(HOME, ".bhai"),
        path.join(HOME, ".atlas"), // pre-rename state root: older builds still use it, and so does Bhai when the copy to ~/.bhai fails
        getBhaiHome(), // the one in use, when BHAI_HOME (or the old ATLAS_HOME) moved it elsewhere
        // Bhai's own state: memory.db (+ -wal), chat history, the WhatsApp session, its
        // browser's cookies, the account session. The deny list named "memories.db", an
        // empty decoy, and the rest of the folder was readable.
        getDataDir(),
        ...(process.env.BHAI_USER_DATA_DIR ? [process.env.BHAI_USER_DATA_DIR] : []),
        // Credentials other apps keep in plain or decryptable form.
        path.join(HOME, ".config", "gh"),
        path.join(HOME, ".config", "gcloud"),
        path.join(HOME, ".azure"),
        path.join(HOME, ".password-store"),
        path.join(HOME, "Library", "Keychains"),
        path.join(HOME, "Library", "Cookies"),
        path.join(HOME, "Library", "Messages"),
        path.join(HOME, "Library", "Mail"),
        path.join(HOME, "Library", "Safari"),
        // Browser profiles (cookies, saved logins): macOS, Linux, Windows.
        ...["Google/Chrome", "BraveSoftware", "Microsoft Edge", "Arc", "Firefox", "Chromium"].map((b) =>
            path.join(HOME, "Library", "Application Support", ...b.split("/")),
        ),
        path.join(HOME, ".config", "google-chrome"),
        path.join(HOME, ".config", "chromium"),
        path.join(HOME, ".config", "BraveSoftware"),
        path.join(HOME, ".mozilla"),
        ...(process.env.LOCALAPPDATA
            ? ["Google/Chrome/User Data", "Microsoft/Edge/User Data", "BraveSoftware"].map((b) =>
                  path.join(process.env.LOCALAPPDATA as string, ...b.split("/")),
              )
            : []),
        // Linux process/kernel pseudo-filesystems. /proc/self/environ dumps THIS
        // process's env (every token in .env — Telegram/Discord/Slack/GitHub/HF…),
        // /proc/self/mem exposes its memory (decrypted vault values, session keys),
        // and /proc/<pid>/* does the same for other processes. No file tool has a
        // legitimate reason to read these; system info uses dedicated code paths.
        // Absolute, so unaffected by HOME; harmless on macOS/Windows (no such tree).
        "/proc",
        "/sys",
    ];
}

// Filename + extension patterns. Case-insensitive everywhere.
const FILENAME_PATTERNS: RegExp[] = [
    /^\.env$/i,
    /^\.env\..+$/i,
    // *.env / *.env.local / *.env.production — common env-file shapes.
    /\.env(\.[a-zA-Z0-9_-]+)?$/i,
    /\.pem$/i,
    /\.enc$/i, // the app's encrypted vault, settings and account session
    /\.p12$/i,
    /private[_-]?key/i,
    /id_rsa(\.pub)?$/i,
    /id_ed25519(\.pub)?$/i,
    /^\.aws[_-]?credentials/i,
];

/**
 * Why a file must not leave the machine (sent to a chat, attached, archived), or null.
 * read and grep already refused these paths, but send_file and the channels' file
 * senders sent any path they were given — keys, the vault, memories.db included.
 */
export function outboundFileRefusal(filePath: string): string | null {
    const check = isSensitivePath(filePath);
    if (check.denied) return `Refused to send it: ${check.reason} Secrets, keys and Bhai's own data never leave the machine.`;
    // A folder that holds one (zipping ~ sweeps in ~/.ssh and ~/.bhai).
    const dir = normalize(filePath) + path.sep;
    const inside = [...deniedDirPrefixes(), ...exactDeniedPaths()].find((p) => startsWith(normalize(p), dir));
    return inside ? `Refused: "${filePath}" contains ${inside}, and secrets never leave the machine.` : null;
}

/**
 * A shell command that names Bhai's own state (its data or app folder, outside the
 * readable subfolders): `cat …/data/memory.db` would print what read refuses.
 * ponytail: a text match, so a wildcard, a variable or a relative path from some other
 * folder ("cd ~/Library/Application\\ Support && cat bhai-desktop/data/…") gets past it;
 * it stops the plain path a page talked the model into. A real fix is a sandboxed shell.
 */
export function shellNamesBhaiState(command: string, cwd?: string): string | null {
    // A command run from inside the folder ("cat memory.db" with cwd = data) names it through cwd.
    const text = `${cwd ? `"${path.resolve(cwd)}" ` : ""}${command}`.replace(/\\ /g, " ").replace(/\$\{?HOME\}?/g, HOME).replace(/(^|[\s"'=:])~(?=\/)/g, `$1${HOME}`);
    const hay = IS_CASE_INSENSITIVE_FS ? text.toLowerCase() : text;
    const roots = [getDataDir(), process.env.BHAI_USER_DATA_DIR].filter((r): r is string => !!r).map((r) => path.resolve(r));
    for (const root of roots) {
        const needle = IS_CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
        for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
            const rest = hay.slice(i + needle.length);
            if (/^[\w.-]/.test(rest)) continue; // a sibling like "data2", not this folder
            const sub = path.relative(getDataDir(), path.join(root, rest.split(/[\s"';|&]/)[0] || "")).split(path.sep)[0];
            if (!READABLE_DATA_SUBDIRS.includes(sub)) return root;
        }
    }
    return null;
}

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

    const dataDir = normalize(getDataDir());
    const readableData = READABLE_DATA_SUBDIRS.some((d) => startsWith(resolved + path.sep, path.join(dataDir, d) + path.sep));
    for (const prefix of deniedDirPrefixes()) {
        const np = normalize(prefix);
        if (readableData && (np === dataDir || startsWith(dataDir, np + path.sep))) continue;
        if (eq(resolved, np) || startsWith(resolved, np + path.sep)) {
            return { denied: true, reason: `Path "${inputPath}" is inside a sensitive directory (${prefix}).` };
        }
    }

    return { denied: false };
}
