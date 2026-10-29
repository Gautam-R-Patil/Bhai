// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── spogo auto-installer ──────────────────────
// Downloads the `spogo` binary from GitHub releases for the current platform
// and installs it to ~/.atlas/bin/spogo. No brew/go/npm deps required — uses
// Node's native https + tar (unix) / PowerShell Expand-Archive (win).
//
// This lets non-technical Electron-app users get full Spotify control without
// touching a terminal.

import { execFile, spawn } from "node:child_process";
import {
    chmodSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { arch, homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IS_LINUX, IS_MAC, IS_WIN } from "./platform.js";

const execFileAsync = promisify(execFile);

// ── Paths ─────────────────────────────────────

export const ATLAS_BIN_DIR = join(homedir(), ".atlas", "bin");

export function spogoBinaryPath(): string {
    return join(ATLAS_BIN_DIR, IS_WIN ? "spogo.exe" : "spogo");
}

function ensureBinDir(): void {
    if (!existsSync(ATLAS_BIN_DIR)) mkdirSync(ATLAS_BIN_DIR, { recursive: true });
}

// ── Asset resolution ──────────────────────────

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface Release {
    tag_name: string;
    assets: ReleaseAsset[];
}

/**
 * Get the right asset suffix for the current platform + arch.
 * spogo release naming: spogo_<version>_<os>_<arch>.(tar.gz|zip)
 *   darwin_amd64, darwin_arm64, linux_amd64, linux_arm64, windows_amd64
 */
function expectedAssetTokens(): { osToken: string; archToken: string; extension: string } {
    const a = arch(); // "x64" | "arm64" | "arm" | ...
    const archToken = a === "x64" ? "amd64" : a === "arm64" ? "arm64" : a;
    if (IS_MAC) return { osToken: "darwin", archToken, extension: "tar.gz" };
    if (IS_LINUX) return { osToken: "linux", archToken, extension: "tar.gz" };
    if (IS_WIN) return { osToken: "windows", archToken: "amd64", extension: "zip" };
    throw new Error(`Unsupported platform: ${platform()}`);
}

// ── HTTPS helpers ─────────────────────────────

function httpsJson<T = unknown>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const doGet = (u: string, depth = 0) => {
            if (depth > 5) return reject(new Error("Too many redirects"));
            httpsGet(
                u,
                { headers: { "User-Agent": "atlas-spotify-installer", Accept: "application/vnd.github+json" } },
                (res: IncomingMessage) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        return doGet(res.headers.location, depth + 1);
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`GitHub API responded ${res.statusCode} for ${u}`));
                    }
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
                        } catch (e) {
                            reject(e);
                        }
                    });
                    res.on("error", reject);
                },
            ).on("error", reject);
        };
        doGet(url);
    });
}

function httpsDownload(url: string, outPath: string, onProgress?: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const doGet = (u: string, depth = 0) => {
            if (depth > 5) return reject(new Error("Too many redirects"));
            httpsGet(u, { headers: { "User-Agent": "atlas-spotify-installer" } }, (res: IncomingMessage) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return doGet(res.headers.location, depth + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Download responded ${res.statusCode} for ${u}`));
                }
                const total = Number(res.headers["content-length"] || 0);
                let received = 0;
                const file = createWriteStream(outPath);
                res.on("data", (chunk: Buffer) => {
                    received += chunk.length;
                    if (onProgress && total) onProgress(Math.min(100, Math.round((received / total) * 100)));
                });
                res.pipe(file);
                file.on("finish", () => file.close(() => resolve()));
                file.on("error", (err) => {
                    try {
                        unlinkSync(outPath);
                    } catch {
                        /* */
                    }
                    reject(err);
                });
            }).on("error", reject);
        };
        doGet(url);
    });
}

// ── Archive extraction ────────────────────────

async function extractTarGz(archivePath: string, extractDir: string): Promise<void> {
    // Use the system `tar` command — available on macOS + Linux by default
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], { timeout: 60_000 });
}

async function extractZip(archivePath: string, extractDir: string): Promise<void> {
    // Use PowerShell Expand-Archive on Windows (built-in, no deps)
    const ps = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { timeout: 60_000 },
        );
        let stderr = "";
        child.stderr?.on("data", (c) => {
            stderr += c.toString();
        });
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Expand-Archive failed (exit ${code}): ${stderr.trim()}`));
        });
        child.on("error", reject);
    });
}

// ── Find the spogo binary inside the extracted dir ──

function findBinaryInDir(dir: string): string | null {
    const target = IS_WIN ? "spogo.exe" : "spogo";
    const walk = (current: string, depth = 0): string | null => {
        if (depth > 3) return null;
        const entries = readdirSync(current, { withFileTypes: true });
        // Check files at this level first
        for (const e of entries) {
            if (e.isFile() && e.name === target) return join(current, e.name);
        }
        // Recurse into subdirs
        for (const e of entries) {
            if (e.isDirectory()) {
                const found = walk(join(current, e.name), depth + 1);
                if (found) return found;
            }
        }
        // Fallback: find first file containing "spogo" (release archives sometimes
        // rename on extraction)
        for (const e of entries) {
            if (e.isFile() && /^spogo/i.test(e.name)) return join(current, e.name);
        }
        return null;
    };
    return walk(dir);
}

// ── Public API ────────────────────────────────

export interface InstallResult {
    success: boolean;
    binaryPath?: string;
    version?: string;
    error?: string;
}

/**
 * Download + install spogo into ~/.atlas/bin. Returns the resolved binary path.
 * If already installed, returns the existing path without re-downloading.
 */
export async function installSpogo(
    opts: { force?: boolean; onProgress?: (msg: string, pct?: number) => void } = {},
): Promise<InstallResult> {
    const log = opts.onProgress || ((msg: string) => console.log(`🎵 spogo: ${msg}`));

    try {
        ensureBinDir();
        const target = spogoBinaryPath();

        // Already installed?
        if (!opts.force && existsSync(target)) {
            try {
                statSync(target); // just to confirm it's accessible
                // Sanity-run --version
                const { stdout } = await execFileAsync(target, ["--version"], { timeout: 3000 });
                log(`already installed: ${stdout.trim().split("\n")[0]}`);
                return { success: true, binaryPath: target, version: stdout.trim() };
            } catch {
                log("existing binary failed version check, re-downloading");
            }
        }

        // Resolve the right release asset
        log("fetching spogo release metadata from GitHub");
        const release = await httpsJson<Release>("https://api.github.com/repos/steipete/spogo/releases/latest");
        if (!release || !Array.isArray(release.assets)) {
            return { success: false, error: "GitHub API returned no assets" };
        }

        const { osToken, archToken, extension } = expectedAssetTokens();
        // Match by containing both tokens + extension (version number varies)
        const asset = release.assets.find(
            (a) => a.name.includes(osToken) && a.name.includes(archToken) && a.name.endsWith(extension),
        );
        if (!asset) {
            // Fallback for Apple Silicon when only amd64 is published — Rosetta can run it
            if (IS_MAC && archToken === "arm64") {
                const amd = release.assets.find(
                    (a) => a.name.includes("darwin") && a.name.includes("amd64") && a.name.endsWith("tar.gz"),
                );
                if (amd) {
                    log(`no arm64 build; falling back to amd64 (Rosetta)`);
                    return await downloadAndInstall(amd, release.tag_name, log);
                }
            }
            return { success: false, error: `No matching asset for ${osToken}_${archToken}.${extension}` };
        }

        return await downloadAndInstall(asset, release.tag_name, log);
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function downloadAndInstall(
    asset: ReleaseAsset,
    tagName: string,
    log: (msg: string, pct?: number) => void,
): Promise<InstallResult> {
    const tmpDir = join(tmpdir(), `atlas-spogo-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const archivePath = join(tmpDir, asset.name);
    log(`downloading ${tagName} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
    let lastPctLogged = 0;
    await httpsDownload(asset.browser_download_url, archivePath, (pct) => {
        if (pct - lastPctLogged >= 25 || pct === 100) {
            lastPctLogged = pct;
            log(`downloading ${pct}%`, pct);
        }
    });

    log("extracting");
    const extractDir = join(tmpDir, "extract");
    mkdirSync(extractDir, { recursive: true });

    if (asset.name.endsWith(".tar.gz")) {
        await extractTarGz(archivePath, extractDir);
    } else if (asset.name.endsWith(".zip")) {
        await extractZip(archivePath, extractDir);
    } else {
        return { success: false, error: `Unknown archive format: ${asset.name}` };
    }

    const extractedBin = findBinaryInDir(extractDir);
    if (!extractedBin) {
        return { success: false, error: "Could not locate spogo binary inside the downloaded archive" };
    }

    const target = spogoBinaryPath();
    // If a prior binary exists, remove it
    try {
        if (existsSync(target)) unlinkSync(target);
    } catch {
        /* */
    }
    renameSync(extractedBin, target);

    if (!IS_WIN) {
        try {
            chmodSync(target, 0o755);
        } catch {
            /* */
        }
    }

    // Verify the installed binary runs
    try {
        const { stdout } = await execFileAsync(target, ["--version"], { timeout: 3000 });
        log(`installed: ${stdout.trim().split("\n")[0]}`);
        return { success: true, binaryPath: target, version: stdout.trim() };
    } catch (err) {
        return { success: false, error: `Installed binary failed to run: ${(err as Error).message}` };
    } finally {
        // Best-effort cleanup of tmp dir
        try {
            const { rmSync } = await import("node:fs");
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* */
        }
    }
}
