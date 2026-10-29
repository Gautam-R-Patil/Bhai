// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 120000; // 2 minutes (3D renders can take time)

// ── Cross-OS Blender resolution ───────────────
// Resolve the Blender executable across macOS / Windows / Linux. Honors
// ATLAS_BLENDER_PATH first, then common install locations, then PATH (`blender`).
async function resolveBlenderPath(): Promise<string | null> {
    const envPath = process.env.ATLAS_BLENDER_PATH;
    if (envPath && existsSync(envPath)) return envPath;

    const candidates: string[] = [];
    if (process.platform === "darwin") {
        candidates.push("/Applications/Blender.app/Contents/MacOS/Blender");
        candidates.push(join(homedir(), "Applications/Blender.app/Contents/MacOS/Blender"));
    } else if (process.platform === "win32") {
        const pf = process.env.ProgramFiles || "C:\\Program Files";
        // Blender installs under a versioned dir (e.g. "Blender Foundation\\Blender 4.2\\blender.exe").
        const root = join(pf, "Blender Foundation");
        if (existsSync(root)) {
            try {
                const versions = await fs.readdir(root);
                for (const v of versions.sort().reverse()) {
                    const exe = join(root, v, "blender.exe");
                    if (existsSync(exe)) candidates.push(exe);
                }
            } catch {
                /* ignore */
            }
        }
        candidates.push(join(pf, "Blender", "blender.exe"));
    } else {
        candidates.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender", "/var/lib/flatpak/exports/bin/org.blender.Blender");
    }
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }

    // Last resort: PATH lookup (`which`/`where`).
    try {
        const finder = process.platform === "win32" ? "where" : "which";
        const { stdout } = await execFileAsync(finder, ["blender"], { timeout: 5000 });
        const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (first && existsSync(first)) return first;
    } catch {
        /* not on PATH */
    }
    return null;
}

// ── Blender Script Tool ───────────────────────

export const blenderScript: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "blender_script",
            description:
                "Execute a Python (bpy) script in Blender to procedurally generate/edit 3D models, scenes, and renders. Cross-OS (macOS/Windows/Linux). Runs headless (--background) by default; set ATLAS_BLENDER_PATH to point at a specific Blender binary.",
            parameters: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description:
                            "The complete, valid Python script using the 'bpy' module to execute inside Blender.",
                    },
                    timeout: {
                        type: "number",
                        description:
                            "Timeout in milliseconds (default: 120000 ms = 2 minutes). Increase this for complex renders.",
                    },
                },
                required: ["script"],
            },
        },
    },

    async handler(input) {
        const script = input.script as string;
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        const blenderPath = await resolveBlenderPath();
        if (!blenderPath) {
            const hint =
                process.platform === "darwin"
                    ? "/Applications/Blender.app"
                    : process.platform === "win32"
                      ? "C:\\Program Files\\Blender Foundation\\Blender <ver>\\blender.exe"
                      : "your package manager (apt/snap/flatpak) or /usr/bin/blender";
            return JSON.stringify({
                error: `Blender not found. Install it (expected near ${hint}) or set ATLAS_BLENDER_PATH to the blender executable.`,
            });
        }

        // Create a temporary python file
        const tmpFile = join(tmpdir(), `atlas_blender_${Date.now()}.py`);

        try {
            await fs.writeFile(tmpFile, script, "utf-8");

            // Execute Blender in background mode, passing the python script
            const { stdout, stderr } = await execFileAsync(blenderPath, ["--background", "--python", tmpFile], {
                timeout,
                maxBuffer: 5 * 1024 * 1024, // 5MB buffer just in case Blender is chatty
            });

            // Cleanup
            await fs.unlink(tmpFile).catch(() => {});

            const output = (stdout || "").substring(0, MAX_OUTPUT);
            const errors = (stderr || "").substring(0, MAX_OUTPUT);

            return JSON.stringify({
                success: true,
                stdout: output,
                stderr: errors,
                truncated: (stdout || "").length > MAX_OUTPUT,
            });
        } catch (err) {
            // Cleanup on error
            await fs.unlink(tmpFile).catch(() => {});

            const error = err as { message?: string; code?: number; killed?: boolean };
            return JSON.stringify({
                success: false,
                error: error.message || "Blender script execution failed.",
                code: error.code,
                killed: error.killed,
            });
        }
    },
};
