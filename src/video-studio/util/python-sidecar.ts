// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "../../config/paths.js";
import { getVSPythonScript } from "./resolve-paths.js";

const execFileAsync = promisify(execFile);

function getVenvDir(): string {
    return path.join(getDataDir(), "video-studio", "venv");
}

function getPyprojectPath(): string {
    return getVSPythonScript("pyproject.toml");
}

function getPythonBin(): string {
    const venv = getVenvDir();
    if (process.platform === "win32") {
        return path.join(venv, "Scripts", "python.exe");
    }
    return path.join(venv, "bin", "python");
}

async function resolveUv(): Promise<string | null> {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const candidates =
        process.platform === "win32"
            ? [
                  "uv",
                  path.join(home, ".cargo", "bin", "uv.exe"),
                  path.join(home, "AppData", "Local", "uv", "uv.exe"),
              ]
            : [
                  "uv",
                  path.join(home, ".cargo", "bin", "uv"),
                  path.join(home, ".local", "bin", "uv"),
              ];
    for (const candidate of candidates) {
        try {
            await execFileAsync(candidate, ["--version"], { timeout: 5000 });
            return candidate;
        } catch {
            // not found at this path
        }
    }
    return null;
}

let _envReady = false;
let _envPromise: Promise<void> | null = null;

export async function ensurePythonEnv(): Promise<void> {
    if (_envReady) return;
    if (_envPromise) return _envPromise;
    _envPromise = _doEnsure().catch((err) => {
        _envPromise = null;
        throw err;
    });
    await _envPromise;
}

async function _doEnsure(): Promise<void> {
    const venvDir = getVenvDir();
    const markerFile = path.join(venvDir, ".bhai-ready");

    // .atlas-ready: a venv set up before the rename is just as ready (skips a ~5 min reinstall).
    if (fs.existsSync(markerFile) || fs.existsSync(path.join(venvDir, ".atlas-ready"))) {
        _envReady = true;
        return;
    }

    console.log("[python-sidecar] Setting up Python venv at", venvDir);
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });

    const uv = await resolveUv();
    if (!uv) {
        throw new Error("[python-sidecar] `uv` not found. Install it: https://github.com/astral-sh/uv#installation");
    }

    await execFileAsync(uv, ["venv", venvDir], { timeout: 60_000 });

    const pyproject = getPyprojectPath();
    if (!fs.existsSync(pyproject)) {
        throw new Error(`[python-sidecar] pyproject.toml not found at ${pyproject}`);
    }

    await execFileAsync(uv, ["pip", "install", "--python", getPythonBin(), "-r", pyproject], { timeout: 300_000 });

    fs.writeFileSync(markerFile, new Date().toISOString(), "utf-8");
    _envReady = true;
    console.log("[python-sidecar] Python env ready.");
}

export function runPython(
    scriptPath: string,
    args: string[],
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
    return new Promise((resolve, reject) => {
        const python = getPythonBin();
        const child = spawn(python, [scriptPath, ...args], {
            env: {
                ...process.env,
                VIRTUAL_ENV: getVenvDir(),
                PATH: `${path.join(getVenvDir(), process.platform === "win32" ? "Scripts" : "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
            },
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
            fn();
        };

        const timeout = opts.timeoutMs
            ? setTimeout(() => {
                  child.kill("SIGTERM");
                  settle(() =>
                      reject(
                          new Error(
                              `[python-sidecar] ${path.basename(scriptPath)} timed out after ${opts.timeoutMs}ms`,
                          ),
                      ),
                  );
              }, opts.timeoutMs)
            : null;

        const onAbort = () => {
            child.kill("SIGTERM");
            settle(() => reject(new Error(`[python-sidecar] ${path.basename(scriptPath)} aborted`)));
        };
        opts.signal?.addEventListener("abort", onAbort);

        child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString("utf-8");
        });
        child.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf-8");
        });

        child.on("close", (code) => {
            if (code === 0) {
                settle(() => resolve(stdout));
            } else {
                settle(() =>
                    reject(new Error(`[python-sidecar] ${path.basename(scriptPath)} exited ${code}.\n${stderr}`)),
                );
            }
        });

        child.on("error", (err) => {
            settle(() => reject(new Error(`[python-sidecar] Failed to spawn ${python}: ${err.message}`)));
        });
    });
}

/** @internal test-only reset */
export function _resetEnvState(): void {
    _envReady = false;
    _envPromise = null;
}
