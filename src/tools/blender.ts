// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 120000; // 2 minutes (3D renders can take time)

// ── Blender Script Tool ───────────────────────

export const blenderScript: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "blender_script",
            description:
                "Execute a Python script in a headless Blender instance. Use this to procedurally generate 3D models, scenes, and renders using the bpy API.",
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
        if (process.platform !== "darwin") {
            return JSON.stringify({
                error: "Currently, blender_script tool assumes macOS path (/Applications/Blender.app/Contents/MacOS/Blender).",
            });
        }

        const script = input.script as string;
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        // Ensure Blender is installed
        const blenderPath = "/Applications/Blender.app/Contents/MacOS/Blender";
        try {
            await fs.access(blenderPath);
        } catch {
            return JSON.stringify({
                error: `Blender not found at ${blenderPath}. Please ensure Blender is installed in the Applications folder.`,
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
