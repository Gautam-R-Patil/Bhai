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

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 300000; // 5 minutes (video rendering takes time)

// ── DaVinci Resolve Script Tool ─────────────────

export const davinciScript: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "davinci_script",
            description:
                "Execute a Python 3 script inside the DaVinci Resolve Studio API environment. Ensure DaVinci Resolve is open before running this. Use this to import media, cut timelines, apply effects, and export videos natively.",
            parameters: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description:
                            "The complete Python script using the 'DaVinciResolveScript'/'import DaVinciResolveScript as dvr_script' module.",
                    },
                    timeout: {
                        type: "number",
                        description:
                            "Timeout in milliseconds (default: 300000 ms = 5 minutes). Increase if doing heavy rendering.",
                    },
                },
                required: ["script"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "davinci_script tool assumes macOS." });
        }

        const script = input.script as string;
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        // Ensure Resolve API variables are set for the python execution environment
        const env = {
            ...process.env,
            RESOLVE_SCRIPT_API: "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
            RESOLVE_SCRIPT_LIB:
                "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
            PYTHONPATH: `${process.env.PYTHONPATH || ""}:/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/`,
        };

        const tmpFile = join(tmpdir(), `atlas_davinci_${Date.now()}.py`);

        try {
            await fs.writeFile(tmpFile, script, "utf-8");

            // We use the system python3. DaVinci requires a compatible python version (usually 3.6-3.10 depending on DVR version)
            const { stdout, stderr } = await execFileAsync("python3", [tmpFile], {
                timeout,
                env,
                maxBuffer: 5 * 1024 * 1024,
            });

            await fs.unlink(tmpFile).catch(() => {});

            return JSON.stringify({
                success: true,
                stdout: (stdout || "").substring(0, MAX_OUTPUT),
                stderr: (stderr || "").substring(0, MAX_OUTPUT),
                truncated: (stdout || "").length > MAX_OUTPUT,
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => {});

            const error = err as {
                message?: string;
                code?: number;
                killed?: boolean;
                stdout?: string;
                stderr?: string;
            };
            return JSON.stringify({
                success: false,
                error: error.message || "DaVinci Resolve script failed",
                code: error.code,
                killed: error.killed,
                stdout: (error.stdout || "").substring(0, 1000),
                stderr: (error.stderr || "").substring(0, 1000),
            });
        }
    },
};
