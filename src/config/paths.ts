// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Centralized Path Configuration ───────────────────
// Provides consistent file paths for bot-generated files.
// Uses BHAI_WORKSPACE (set by installer) as the primary output directory.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ── Bhai Home (~/.bhai) ─────────────────────────────
// Internal state root (store/, data/, hooks.json…). Bhai was called ATLAS, so
// an older install kept it in ~/.atlas; the first call copies that over once.

/** The pre-rename state root. Only read as a fallback, never written to. */
export const LEGACY_HOME = path.join(os.homedir(), ".atlas");

let _bhaiHome: string | null = null;

function resolveBhaiHome(): string {
    const home = path.join(os.homedir(), ".bhai");
    const legacy = LEGACY_HOME;
    if (fs.existsSync(home) || !fs.existsSync(legacy)) return home;
    // A copy that failed (full disk, unreadable file) is retried a day later, not on every start.
    const failed = path.join(legacy, ".bhai-copy-failed");
    if (fs.existsSync(failed) && Date.now() - fs.statSync(failed).mtimeMs < 86_400_000) return legacy;
    // Leftovers of a copy that was killed midway (another pid's is still running if it's fresh).
    for (const f of fs.readdirSync(os.homedir())) {
        const p = path.join(os.homedir(), f);
        if (f.startsWith(".bhai.tmp-") && Date.now() - fs.statSync(p).mtimeMs > 600_000) fs.rmSync(p, { recursive: true, force: true });
    }
    // Copy, never move: an older Bhai build (or its com.atlas.bridge host script) may still run
    // from ~/.atlas. Copy into a private temp dir, then rename it into place atomically.
    // models/ holds re-downloadable caches (hundreds of MB): moved after, not copied.
    const tmp = `${home}.tmp-${process.pid}`;
    const skip = new Set([path.join(legacy, "models"), failed]);
    try {
        fs.mkdirSync(tmp, { mode: 0o700 });
        fs.cpSync(legacy, tmp, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.has(src) });
        fs.renameSync(tmp, home);
        try {
            fs.renameSync(path.join(legacy, "models"), path.join(home, "models"));
        } catch {
            /* none, or another volume: re-downloaded on demand */
        }
        console.log(`📁 Copied ${legacy} → ${home}`);
        return home;
    } catch {
        // Copy failed, or another process (the desktop does the same) got there first.
        fs.rmSync(tmp, { recursive: true, force: true });
        if (fs.existsSync(home)) return home;
        try {
            fs.writeFileSync(failed, "");
        } catch {
            /* read-only: retried next start */
        }
        return legacy;
    }
}

/**
 * Bhai's state root: $BHAI_HOME, else ~/.bhai (copied from ~/.atlas on first use;
 * stays on ~/.atlas when that copy fails). Read BHAI_HOME on every call so tests
 * can point it elsewhere; the default is resolved once.
 */
export function getBhaiHome(): string {
    if (process.env.BHAI_HOME) return process.env.BHAI_HOME;
    if (_bhaiHome === null) _bhaiHome = resolveBhaiHome();
    return _bhaiHome;
}

// ── Bhai Workspace Directory ────────────────────────
// This is where all bot-generated files should be saved.
// Set by the desktop installer during setup.

function getBhaiWorkspace(): string {
    // Priority 1: Environment variable (set by desktop app)
    const envWorkspace = process.env.BHAI_WORKSPACE;
    if (envWorkspace && fs.existsSync(envWorkspace)) {
        return envWorkspace;
    }

    // Priority 2: Default locations based on OS
    const homeDir = os.homedir();
    const defaultLocations = [
        path.join(homeDir, "Desktop", "Bhai Files"),
        path.join(homeDir, "Documents", "Bhai Files"),
        path.join(getBhaiHome(), "files"),
    ];

    for (const loc of defaultLocations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }

    // Priority 3: Create default directory
    const defaultDir = path.join(homeDir, "Bhai Files");
    try {
        fs.mkdirSync(defaultDir, { recursive: true });
        console.log(`📁 Created Bhai files directory: ${defaultDir}`);
        return defaultDir;
    } catch {
        // Fallback to temp directory
        return os.tmpdir();
    }
}

// Cached workspace path
let _workspacePath: string | null = null;

/**
 * Get the Bhai workspace directory where bot-generated files should be saved.
 * This is the user-facing folder for all outputs (images, documents, downloads, etc.)
 */
export function getWorkspaceDir(): string {
    if (!_workspacePath) {
        _workspacePath = getBhaiWorkspace();
    }
    return _workspacePath;
}

/**
 * Get a subdirectory within the workspace for organized file storage.
 * Creates the subdirectory if it doesn't exist.
 */
export function getWorkspaceSubdir(subdir: string): string {
    const dir = path.join(getWorkspaceDir(), subdir);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ── Bundled Helper Scripts ───────────────────────────
// The packaged desktop app is a single esbuild bundle at
// Contents/Resources/bot/bot-bundle.mjs, so import.meta.url resolves __dirname
// to .../bot (flat) — NOT dist/src/config. A naive join(__dirname,"..","..")
// overshoots and misses the scripts/ dir (electron-builder ships it at
// <Resources>/bot/scripts via extraResources). These resolvers try every
// layout and existsSync-pick the right one, fixing helper lookup (dump_ax_bin,
// dump_uia.ps1, dump_atspi.py, omniparser_detect.py, OCR, vision overlays)
// across dev, compiled dist, and the packaged app on macOS/Windows/Linux.

const _scriptsHere = path.dirname(fileURLToPath(import.meta.url));

function scriptCandidateDirs(): string[] {
    const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    return [
        path.join(_scriptsHere, "..", "..", "scripts"), // dev/dist: dist/src/config → repo root
        path.join(_scriptsHere, "..", "scripts"),
        path.join(_scriptsHere, "scripts"), // bundle: __dirname = .../bot → .../bot/scripts
        path.join(process.cwd(), "scripts"), // Electron cwd = bot/
        ...(rp ? [path.join(rp, "bot", "scripts"), path.join(rp, "scripts")] : []),
    ];
}

/**
 * Resolve the bundled `scripts/` directory across dev, compiled dist, and the
 * single-file Electron bundle. Returns the first candidate that exists, or the
 * dev path as a never-null fallback (callers gate on existsSync of the helper).
 */
export function getScriptsDir(): string {
    const dirs = scriptCandidateDirs();
    return dirs.find((d) => fs.existsSync(d)) ?? dirs[0];
}

/**
 * Resolve a single helper script by name, picking the first candidate directory
 * that actually contains it. Returns null when the helper isn't found anywhere.
 */
export function resolveScript(name: string): string | null {
    for (const d of scriptCandidateDirs()) {
        const p = path.join(d, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// ── Specific Output Directories ──────────────────────

/**
 * Directory for AI-generated images
 */
export function getImagesDir(): string {
    return getWorkspaceSubdir("Images");
}

/**
 * Directory for research reports and documents
 */
export function getDocumentsDir(): string {
    return getWorkspaceSubdir("Documents");
}

/**
 * Directory for downloaded files
 */
export function getDownloadsDir(): string {
    return getWorkspaceSubdir("Downloads");
}

/**
 * Directory for screenshots and screen captures
 */
export function getScreenshotsDir(): string {
    return getWorkspaceSubdir("Screenshots");
}

/**
 * Directory for code and project files
 */
export function getCodeDir(): string {
    return getWorkspaceSubdir("Code");
}

/**
 * Directory for temporary/working files
 */
export function getTempDir(): string {
    return getWorkspaceSubdir(".temp");
}

/**
 * Directory for exports (PDF, archives, etc.)
 */
export function getExportsDir(): string {
    return getWorkspaceSubdir("Exports");
}

/**
 * Directory for AI-generated presentations (PPTX, PDF, HTML decks).
 */
export function getPresentationsDir(): string {
    return getWorkspaceSubdir("Presentations");
}

// ── Path Helpers ─────────────────────────────────────

/**
 * Generate a unique filename with timestamp to avoid collisions.
 * @param baseName Base name for the file (e.g., "image", "report")
 * @param extension File extension (e.g., "png", "pdf")
 * @returns Full path in the appropriate workspace subdirectory
 */
export function generateFilePath(baseName: string, extension: string, subdir?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${baseName}_${timestamp}.${extension}`;
    const dir = subdir ? getWorkspaceSubdir(subdir) : getWorkspaceDir();
    return path.join(dir, filename);
}

/**
 * Generate a path for an AI-generated image.
 */
export function generateImagePath(description?: string): string {
    const baseName = description
        ? description.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
        : "image";
    return generateFilePath(baseName, "png", "Images");
}

/**
 * Generate a path for a research report.
 */
export function generateReportPath(topic?: string): string {
    const baseName = topic
        ? topic.slice(0, 40).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
        : "report";
    return generateFilePath(baseName, "md", "Documents");
}

/**
 * Generate a path for a screenshot.
 */
export function generateScreenshotPath(): string {
    return generateFilePath("screenshot", "png", "Screenshots");
}

/**
 * Check if workspace is properly configured
 */
export function isWorkspaceConfigured(): boolean {
    const workspace = getWorkspaceDir();
    return workspace !== os.tmpdir() && fs.existsSync(workspace);
}

/**
 * Get the data directory (internal bot data, not user-facing).
 * This is separate from the workspace - used for databases, caches, etc.
 */
export function getDataDir(): string {
    return process.env.BHAI_DATA_DIR || path.resolve("data");
}
