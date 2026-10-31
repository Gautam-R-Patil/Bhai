// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Bhai used to be called ATLAS. Settings, files and bot builds from before the
// rename still carry the old names: these read them as a fallback, and Bhai
// only ever writes the new ones. No Electron imports here (testable).

const fs = require("fs");
const path = require("path");

/** process.env BHAI_<name>, else the old ATLAS_<name> a user's shell may still set. */
const envOf = (name, env = process.env) => env[`BHAI_${name}`] ?? env[`ATLAS_${name}`];

/**
 * Settings text (.env.enc) with each old ATLAS_X line renamed BHAI_X, so every reader
 * finds the new name and the next save writes it back without the old one.
 * Where both are set, the BHAI_X line wins and the ATLAS_X line is dropped.
 */
function upgradeEnvText(text) {
    if (!text || !text.includes("ATLAS_")) return text;
    const lines = text.split("\n");
    const keyOf = (l) => (l.match(/^\s*([A-Z0-9_]+)\s*=/) || [])[1];
    const keys = new Set(lines.map(keyOf));
    return lines
        .filter((l) => !(keyOf(l)?.startsWith("ATLAS_") && keys.has(`BHAI_${keyOf(l).slice(6)}`)))
        .map((l) => l.replace(/^(\s*)ATLAS_(?=[A-Z0-9_]*\s*=)/, "$1BHAI_"))
        .join("\n");
}

/**
 * Settings text to save: every BHAI_X line also written as ATLAS_X with the same value,
 * so a pre-rename build (after a channel downgrade) still finds its settings.
 * upgradeEnvText drops those twins again on load. Drop after a release or two.
 */
function withLegacyEnvNames(text) {
    if (!text || !text.includes("BHAI_")) return text;
    const lines = text.split("\n").filter((l) => !/^\s*ATLAS_[A-Z0-9_]*\s*=/.test(l));
    return lines.flatMap((l) => (/^\s*BHAI_[A-Z0-9_]*\s*=/.test(l) ? [l, l.replace("BHAI_", "ATLAS_")] : [l])).join("\n");
}

/** Bot output with a pre-rename build's ##ATLAS_X## markers read as ##BHAI_X##. */
const upgradeMarkers = (text) => text.replaceAll("##ATLAS_", "##BHAI_");

/** The date in a bhai-YYYY-MM-DD.log name (or an old atlas-… one), else null. */
const logDate = (file) => file.match(/^(?:bhai|atlas)-(\d{4}-\d{2}-\d{2})\.log$/)?.[1] ?? null;

/**
 * `newPath`, copied from `oldPath` when only the old one is there or the old one is
 * newer (an older build, after a channel downgrade, wrote it since). Copy, never move,
 * so that older build still finds its file. Same bytes: encrypted files stay readable.
 * `oldPath` itself if the copy fails.
 */
function adoptLegacy(newPath, oldPath) {
    if (!fs.existsSync(oldPath)) return newPath;
    try {
        if (!fs.existsSync(newPath) || fs.statSync(oldPath).mtimeMs > fs.statSync(newPath).mtimeMs) {
            fs.copyFileSync(oldPath, newPath);
        }
        return newPath;
    } catch {
        return fs.existsSync(newPath) ? newPath : oldPath;
    }
}

/**
 * `newDir`, copied from `oldDir` first when only the old one is there. Copy, never
 * move: an older Bhai build (or its com.atlas.bridge host script) may still use
 * `oldDir`. Same rule as the bot's resolveBhaiHome (src/config/paths.ts): private
 * temp dir renamed into place, models/ (re-downloadable caches) moved after, stale
 * temp dirs swept, a failed copy retried a day later instead of on every start.
 */
function copyLegacyDir(newDir, oldDir) {
    if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return newDir;
    const failed = path.join(oldDir, ".bhai-copy-failed");
    if (fs.existsSync(failed) && Date.now() - fs.statSync(failed).mtimeMs < 86_400_000) return oldDir;
    const parent = path.dirname(newDir);
    const tmpPrefix = `${path.basename(newDir)}.tmp-`;
    for (const f of fs.readdirSync(parent)) {
        const p = path.join(parent, f);
        if (f.startsWith(tmpPrefix) && Date.now() - fs.statSync(p).mtimeMs > 600_000) fs.rmSync(p, { recursive: true, force: true });
    }
    const tmp = `${newDir}.tmp-${process.pid}`;
    const skip = new Set([path.join(oldDir, "models"), failed]);
    try {
        fs.mkdirSync(tmp, { mode: 0o700 });
        fs.cpSync(oldDir, tmp, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.has(src) });
        fs.renameSync(tmp, newDir);
        try { fs.renameSync(path.join(oldDir, "models"), path.join(newDir, "models")); } catch { /* re-downloaded on demand */ }
        return newDir;
    } catch {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (fs.existsSync(newDir)) return newDir;
        try { fs.writeFileSync(failed, ""); } catch { /* retried next start */ }
        return oldDir;
    }
}

/** Bhai's state root: $BHAI_HOME, else ~/.bhai (copied over from ~/.atlas once). */
const bhaiHome = (home, env = process.env) =>
    envOf("HOME", env) || copyLegacyDir(path.join(home, ".bhai"), path.join(home, ".atlas"));

module.exports = { envOf, upgradeEnvText, withLegacyEnvNames, upgradeMarkers, logDate, adoptLegacy, copyLegacyDir, bhaiHome };
