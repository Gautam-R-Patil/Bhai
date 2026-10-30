// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── File & Utility Tools ──────────────────────
// Screen recording, file tags, compression, trash, shortcuts, and open-in-app.

import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getExportsDir } from "../config/paths.js";
import { isPathAllowed, isProtectedPath } from "../security/allowlist.js";
import { isSensitivePath, outboundFileRefusal } from "../security/sensitive-paths.js";
import type { ToolDefinition } from "./get-current-time.js";
import { IS_MAC, IS_WIN, nativeOpen, runPowerShell, runPowerShellInline } from "./platform.js";
import { getTelegramContext } from "./send-file.js";

const execFileAsync = promisify(execFile);

// ── Helper ────────────────────────────────────

async function runAS(script: string, timeout = 10000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_util_${Date.now()}.scpt`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", [tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
}

// ── Active screen recordings ──────────────────

let activeRecordingPid: number | null = null;
let activeRecordingPath: string | null = null;

// ═══════════════════════════════════════════════
// 1. SCREEN RECORD
// ═══════════════════════════════════════════════

export const screenRecord: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "screen_record",
            description:
                "Start or stop a screen recording. Use 'start' to begin recording, 'stop' to end and optionally send the recording to the user.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["start", "stop", "status"],
                        description: "Action: start recording, stop and send, or check status",
                    },
                    duration_sec: {
                        type: "number",
                        description: "Auto-stop after this many seconds (for 'start'; max 300). Omit for manual stop.",
                    },
                    send: {
                        type: "boolean",
                        description: "Send the recording to the user on Telegram after stopping (default: true)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        try {
            switch (action) {
                case "start": {
                    if (activeRecordingPid) {
                        return JSON.stringify({
                            error: "A recording is already in progress. Stop it first.",
                            pid: activeRecordingPid,
                        });
                    }

                    const durationSec = input.duration_sec as number | undefined;

                    if (IS_WIN) {
                        // Windows: use FFmpeg if available
                        const outputPath = join(tmpdir(), `atlas_recording_${Date.now()}.mp4`);
                        try {
                            const args = ["-f", "gdigrab", "-framerate", "15", "-i", "desktop", "-y"];
                            if (durationSec) args.push("-t", String(Math.min(durationSec, 300)));
                            args.push(outputPath);
                            const proc = execFile("ffmpeg", args);
                            activeRecordingPid = proc.pid || null;
                            activeRecordingPath = outputPath;
                            if (durationSec) {
                                setTimeout(
                                    () => {
                                        if (activeRecordingPid === proc.pid) activeRecordingPid = null;
                                    },
                                    (durationSec + 2) * 1000,
                                );
                            }
                            return JSON.stringify({
                                success: true,
                                action: "start",
                                pid: activeRecordingPid,
                                output_path: outputPath,
                                note: "🔴 Recording started (FFmpeg).",
                            });
                        } catch {
                            return JSON.stringify({
                                error: "Screen recording requires FFmpeg on Windows. Install FFmpeg and add to PATH.",
                            });
                        }
                    }

                    if (!IS_MAC) {
                        return JSON.stringify({
                            error: "Screen recording requires FFmpeg on this platform. Install FFmpeg and add to PATH.",
                        });
                    }

                    // macOS: use screencapture
                    const outputPath = join(tmpdir(), `atlas_recording_${Date.now()}.mov`);
                    const args = ["-x", outputPath];
                    if (durationSec) {
                        args.push("-V", String(Math.min(durationSec, 300)));
                    }

                    const proc = execFile("screencapture", args);
                    activeRecordingPid = proc.pid || null;
                    activeRecordingPath = outputPath;

                    if (durationSec) {
                        setTimeout(
                            () => {
                                if (activeRecordingPid === proc.pid) {
                                    activeRecordingPid = null;
                                }
                            },
                            (durationSec + 2) * 1000,
                        );
                    }

                    return JSON.stringify({
                        success: true,
                        action: "start",
                        pid: activeRecordingPid,
                        output_path: outputPath,
                        duration: durationSec ? `${durationSec}s` : "manual",
                        note: "🔴 Recording started.",
                    });
                }

                case "stop": {
                    const shouldSend = input.send !== false;

                    if (activeRecordingPid) {
                        // Kill the screencapture process to stop recording
                        try {
                            process.kill(activeRecordingPid, "SIGINT");
                        } catch {
                            /* already dead */
                        }
                        // Wait for file to be finalized
                        await new Promise((r) => setTimeout(r, 1500));
                    }

                    const recPath = activeRecordingPath;
                    activeRecordingPid = null;
                    activeRecordingPath = null;

                    if (!recPath || !existsSync(recPath)) {
                        return JSON.stringify({ error: "No active recording found or file doesn't exist." });
                    }

                    const stats = statSync(recPath);
                    const sizeKb = Math.round(stats.size / 1024);

                    if (shouldSend) {
                        const { bot, chatId } = getTelegramContext();
                        if (bot && chatId) {
                            try {
                                const fileBuffer = readFileSync(recPath);
                                const { InputFile } = await import("grammy");
                                const inputFile = new InputFile(fileBuffer, `screen_recording_${Date.now()}.mov`);
                                await bot.api.sendVideo(chatId, inputFile, { caption: "📹 Screen recording" });
                                await fs.unlink(recPath).catch(() => {});
                                return JSON.stringify({ success: true, action: "stop", sent: true, size_kb: sizeKb });
                            } catch (sendErr) {
                                return JSON.stringify({
                                    success: true,
                                    action: "stop",
                                    sent: false,
                                    error: `Recording saved but failed to send: ${(sendErr as Error).message}`,
                                    path: recPath,
                                    size_kb: sizeKb,
                                });
                            }
                        }
                    }

                    return JSON.stringify({ success: true, action: "stop", path: recPath, size_kb: sizeKb });
                }

                case "status": {
                    return JSON.stringify({
                        recording: !!activeRecordingPid,
                        pid: activeRecordingPid,
                        path: activeRecordingPath,
                    });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 2. FILE METADATA (Finder Tags & Spotlight)
// ═══════════════════════════════════════════════

export const fileMetadata: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "file_metadata",
            description:
                "Get or set macOS file metadata: Finder tags (colored labels), Spotlight comments, file info (creation date, type, size).",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["get", "set_tags", "set_comment", "get_info"],
                        description: "Action to perform",
                    },
                    path: { type: "string", description: "File or folder path" },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Tags to set (for 'set_tags'). Colors: Red, Orange, Yellow, Green, Blue, Purple, Gray. Or any custom tag name.",
                    },
                    comment: { type: "string", description: "Spotlight comment to set (for 'set_comment')" },
                },
                required: ["action", "path"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;
        const filePath = input.path as string;

        if (!existsSync(filePath)) {
            return JSON.stringify({ error: `Path not found: ${filePath}` });
        }

        try {
            switch (action) {
                case "get": {
                    if (IS_MAC) {
                        // Get tags via xattr (macOS only)
                        const { stdout: tagOut } = await execFileAsync(
                            "xattr",
                            ["-p", "com.apple.metadata:_kMDItemUserTags", filePath],
                            { timeout: 3000 },
                        ).catch(() => ({ stdout: "" }));
                        // Get Spotlight comment via mdls (macOS only)
                        const { stdout: commentOut } = await execFileAsync(
                            "mdls",
                            ["-name", "kMDItemFinderComment", filePath],
                            { timeout: 3000 },
                        ).catch(() => ({ stdout: "" }));
                        const comment = commentOut.match(/"([^"]+)"/)?.[1] || "";

                        // Parse tags from plist binary
                        let tags: string[] = [];
                        if (tagOut) {
                            const tagMatches = tagOut.match(/<string>([^<]+)<\/string>/g);
                            if (tagMatches) {
                                tags = tagMatches.map((m) => m.replace(/<\/?string>/g, "").split("\n")[0]);
                            }
                        }

                        return JSON.stringify({ success: true, path: filePath, tags, comment });
                    }

                    if (IS_WIN) {
                        // Windows: return basic file properties via PowerShell
                        try {
                            const result = await runPowerShellInline(
                                `Get-ItemProperty -LiteralPath '${filePath.replace(/'/g, "''")}' | Select-Object CreationTime, LastWriteTime, Length, Attributes | ConvertTo-Json -Compress`,
                                5000,
                            );
                            const info = JSON.parse(result.trim() || "{}");
                            return JSON.stringify({
                                success: true,
                                path: filePath,
                                tags: [],
                                comment: "",
                                windowsProperties: info,
                            });
                        } catch {
                            // Fall through to basic stat
                        }
                    }

                    // Fallback: basic stat info
                    const stat = statSync(filePath);
                    return JSON.stringify({
                        success: true,
                        path: filePath,
                        tags: [],
                        comment: "",
                        metadata: {
                            size: stat.size,
                            created: stat.birthtime.toISOString(),
                            modified: stat.mtime.toISOString(),
                        },
                    });
                }

                case "set_tags": {
                    if (!IS_MAC) {
                        return JSON.stringify({ error: "File tags (Finder tags) are only supported on macOS." });
                    }
                    const tags = input.tags as string[];
                    if (!tags || tags.length === 0) return JSON.stringify({ error: "Provide 'tags' array." });
                    // Build plist XML for tags
                    const plistItems = tags.map((t) => `<string>${t}</string>`).join("");
                    const plist = `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array>${plistItems}</array></plist>`;
                    const tmpFile = join(tmpdir(), `tags_${Date.now()}.plist`);
                    await fs.writeFile(tmpFile, plist, "utf-8");
                    await execFileAsync("xattr", ["-w", "com.apple.metadata:_kMDItemUserTags", plist, filePath], {
                        timeout: 3000,
                    });
                    await fs.unlink(tmpFile).catch(() => {});
                    return JSON.stringify({ success: true, path: filePath, tags });
                }

                case "set_comment": {
                    if (!IS_MAC) {
                        return JSON.stringify({ error: "Spotlight comments are only supported on macOS." });
                    }
                    const comment = input.comment as string;
                    if (comment === undefined) return JSON.stringify({ error: "Provide 'comment' text." });
                    const escaped = comment.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                    await runAS(`
tell application "Finder"
    set comment of (POSIX file "${filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" as alias) to "${escaped}"
end tell`);
                    return JSON.stringify({ success: true, path: filePath, comment });
                }

                case "get_info": {
                    if (IS_MAC) {
                        const { stdout } = await execFileAsync("mdls", [filePath], { timeout: 5000 });
                        // Parse key fields
                        const info: Record<string, string> = {};
                        const fields = [
                            "kMDItemContentType",
                            "kMDItemFSSize",
                            "kMDItemFSCreationDate",
                            "kMDItemFSContentChangeDate",
                            "kMDItemDisplayName",
                            "kMDItemKind",
                        ];
                        for (const field of fields) {
                            const match = stdout.match(new RegExp(`${field}\\s+=\\s+(.+)`));
                            if (match) info[field.replace("kMDItem", "")] = match[1].trim();
                        }
                        return JSON.stringify({ success: true, path: filePath, metadata: info });
                    }

                    if (IS_WIN) {
                        try {
                            const result = await runPowerShellInline(
                                `Get-ItemProperty -LiteralPath '${filePath.replace(/'/g, "''")}' | Select-Object CreationTime, LastWriteTime, Length, Extension, Attributes | ConvertTo-Json -Compress`,
                                5000,
                            );
                            return JSON.stringify({
                                success: true,
                                path: filePath,
                                metadata: JSON.parse(result.trim() || "{}"),
                            });
                        } catch {
                            // Fall through
                        }
                    }

                    // Fallback: basic stat
                    const stat = statSync(filePath);
                    return JSON.stringify({
                        success: true,
                        path: filePath,
                        metadata: {
                            size: stat.size,
                            created: stat.birthtime.toISOString(),
                            modified: stat.mtime.toISOString(),
                        },
                    });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 3. COMPRESS FILES
// ═══════════════════════════════════════════════

export const compressFiles: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "compress_files",
            description: "Compress files/folders into a zip archive or extract a zip/tar archive.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["zip", "unzip"],
                        description: "Compress (zip) or extract (unzip)",
                    },
                    paths: {
                        type: "array",
                        items: { type: "string" },
                        description: "File/folder paths to compress (for 'zip')",
                    },
                    archive_path: {
                        type: "string",
                        description:
                            "Path to the archive file. For 'zip': output path (default: auto-named in Bhai Exports folder). For 'unzip': archive to extract.",
                    },
                    output_dir: {
                        type: "string",
                        description: "Output directory for extraction (for 'unzip', default: same dir as archive)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        try {
            if (action === "zip") {
                const paths = input.paths as string[];
                if (!paths || paths.length === 0) return JSON.stringify({ error: "Provide 'paths' to compress." });

                // Verify all paths exist, and none is (or holds) a secret: the archive is
                // an ordinary file that send_file would happily send.
                for (const p of paths) {
                    if (!existsSync(p)) return JSON.stringify({ error: `Path not found: ${p}` });
                    const refused = outboundFileRefusal(p);
                    if (refused) return JSON.stringify({ error: refused });
                }

                const archivePath =
                    (input.archive_path as string) || join(getExportsDir(), `archive_${Date.now()}.zip`);

                if (IS_MAC) {
                    await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", ...paths, archivePath], {
                        timeout: 60000,
                    });
                } else {
                    // Windows/Linux: use zip command or PowerShell
                    if (IS_WIN) {
                        const pathList = paths.map((p: string) => `"${p}"`).join(", ");
                        await runPowerShellInline(
                            `Compress-Archive -Path ${pathList} -DestinationPath "${archivePath}" -Force`,
                            60000,
                        );
                    } else {
                        await execFileAsync("zip", ["-r", archivePath, ...paths], { timeout: 60000 });
                    }
                }

                const stats = statSync(archivePath);
                return JSON.stringify({
                    success: true,
                    action: "zip",
                    archive: archivePath,
                    size_mb: Math.round((stats.size / 1048576) * 100) / 100,
                    files: paths.map((p: string) => basename(p)),
                });
            }

            if (action === "unzip") {
                const archivePath = input.archive_path as string;
                if (!archivePath)
                    return JSON.stringify({ error: "Provide 'archive_path' for the archive to extract." });
                if (!existsSync(archivePath)) return JSON.stringify({ error: `Archive not found: ${archivePath}` });

                const outputDir =
                    (input.output_dir as string) ||
                    join(dirname(archivePath), basename(archivePath, extname(archivePath)));

                // Extraction writes (and overwrites) everything in the archive under outputDir.
                const outAbs = resolve(outputDir);
                if (!isPathAllowed(outAbs) || isProtectedPath(outAbs) || isSensitivePath(outAbs).denied) {
                    return JSON.stringify({ error: `Refused to extract into ${outputDir}: protected or sensitive location.` });
                }

                const ext = extname(archivePath).toLowerCase();
                if (ext === ".zip") {
                    if (IS_MAC) {
                        await execFileAsync("ditto", ["-x", "-k", archivePath, outputDir], { timeout: 60000 });
                    } else if (IS_WIN) {
                        await runPowerShellInline(
                            `Expand-Archive -Path "${archivePath}" -DestinationPath "${outputDir}" -Force`,
                            60000,
                        );
                    } else {
                        await fs.mkdir(outputDir, { recursive: true });
                        await execFileAsync("unzip", ["-o", archivePath, "-d", outputDir], { timeout: 60000 });
                    }
                } else if (ext === ".tar" || ext === ".gz" || ext === ".tgz") {
                    await fs.mkdir(outputDir, { recursive: true });
                    await execFileAsync("tar", ["-xf", archivePath, "-C", outputDir], { timeout: 60000 });
                } else {
                    return JSON.stringify({
                        error: `Unsupported archive format: ${ext}. Supported: .zip, .tar, .gz, .tgz`,
                    });
                }

                return JSON.stringify({
                    success: true,
                    action: "unzip",
                    extracted_to: outputDir,
                });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 4. TRASH MANAGER
// ═══════════════════════════════════════════════

export const trashManager: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "trash_manager",
            description:
                "Manage the system Trash/Recycle Bin: move files to Trash (safe delete), empty Trash, or list Trash contents with total size.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["trash", "empty", "list"],
                        description:
                            "Action: 'trash' to move a file to Trash, 'empty' to empty Trash, 'list' to see contents",
                    },
                    path: { type: "string", description: "File/folder path to move to Trash (for 'trash' action)" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        try {
            switch (action) {
                case "trash": {
                    const filePath = input.path as string;
                    if (!filePath) return JSON.stringify({ error: "Provide 'path' to move to Trash." });
                    if (!existsSync(filePath)) return JSON.stringify({ error: `Path not found: ${filePath}` });

                    if (IS_WIN) {
                        // Windows: use Shell.Application COM to recycle
                        const absPath = resolve(filePath);
                        await runPowerShell(
                            `
$shell = New-Object -ComObject Shell.Application
$item = $shell.NameSpace(0).ParseName("${absPath.replace(/\\/g, "\\\\")}")
if ($item) { $item.InvokeVerb("delete") } else { Write-Error "Item not found" }
`,
                            10000,
                        );
                    } else {
                        await runAS(`
tell application "Finder"
    move POSIX file "${filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" to trash
end tell`);
                    }
                    return JSON.stringify({ success: true, action: "trash", trashed: basename(filePath) });
                }

                case "empty": {
                    if (IS_WIN) {
                        await runPowerShellInline(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue`, 15000);
                    } else {
                        await runAS(
                            `
tell application "Finder"
    empty the trash
end tell`,
                            30000,
                        );
                    }
                    return JSON.stringify({ success: true, action: "empty", note: "🗑️ Trash emptied." });
                }

                case "list": {
                    let trashPath: string;
                    if (IS_WIN) {
                        // Windows Recycle Bin — use Shell.Application
                        try {
                            const result = await runPowerShell(
                                `
$shell = New-Object -ComObject Shell.Application
$recycleBin = $shell.NameSpace(0xA)
$items = $recycleBin.Items()
$count = $items.Count
$list = @()
foreach ($item in $items) {
    $list += "$($item.Name)|$($item.Size)"
}
$list -join '\n'
Write-Output "---$count"
`,
                                10000,
                            );
                            const lines = result.split("\n").filter(Boolean);
                            const countLine = lines.find((l) => l.startsWith("---"));
                            const count = countLine ? parseInt(countLine.replace("---", "")) : 0;
                            const itemLines = lines.filter((l) => !l.startsWith("---")).slice(0, 20);
                            const items = itemLines.map((l) => {
                                const [name, size] = l.split("|");
                                return { name, size_kb: Math.round((parseInt(size) || 0) / 1024), type: "unknown" };
                            });
                            return JSON.stringify({ success: true, count, items, truncated: count > 20 });
                        } catch {
                            return JSON.stringify({
                                success: true,
                                count: 0,
                                items: [],
                                note: "Could not query Recycle Bin.",
                            });
                        }
                    }

                    // macOS
                    trashPath = join(homedir(), ".Trash");
                    try {
                        const entries = await fs.readdir(trashPath);
                        const items: Array<{ name: string; size_kb: number; type: string }> = [];
                        let totalSize = 0;
                        for (const name of entries.slice(0, 50)) {
                            try {
                                const stats = statSync(join(trashPath, name));
                                const size = stats.size;
                                totalSize += size;
                                items.push({
                                    name,
                                    size_kb: Math.round(size / 1024),
                                    type: stats.isDirectory() ? "folder" : "file",
                                });
                            } catch {
                                /* skip */
                            }
                        }
                        return JSON.stringify({
                            success: true,
                            count: entries.length,
                            total_size_mb: Math.round((totalSize / 1048576) * 100) / 100,
                            items: items.slice(0, 20),
                            truncated: entries.length > 20,
                        });
                    } catch {
                        return JSON.stringify({ success: true, count: 0, items: [] });
                    }
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 5. RUN SHORTCUT (Apple Shortcuts)
// ═══════════════════════════════════════════════

export const runShortcut: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "run_shortcut",
            description:
                "Run an Apple Shortcut by name, or list all available shortcuts. Shortcuts.app must be set up with the desired shortcuts first.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["run", "list"],
                        description: "Run a shortcut by name, or list all available shortcuts",
                    },
                    name: { type: "string", description: "Name of the shortcut to run (for 'run' action)" },
                    input: { type: "string", description: "Optional text input to pass to the shortcut" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({ error: "Apple Shortcuts are only available on macOS." });
        }

        const action = input.action as string;

        try {
            if (action === "list") {
                const { stdout } = await execFileAsync("shortcuts", ["list"], { timeout: 10000 });
                const shortcuts = stdout.trim().split("\n").filter(Boolean);
                return JSON.stringify({ success: true, count: shortcuts.length, shortcuts });
            }

            if (action === "run") {
                const name = input.name as string;
                if (!name) return JSON.stringify({ error: "Provide 'name' of the shortcut to run." });

                const textInput = input.input as string;
                const args = ["run", name];
                if (textInput) {
                    args.push("-i", textInput);
                }

                const { stdout } = await execFileAsync("shortcuts", args, { timeout: 30000 });
                return JSON.stringify({
                    success: true,
                    shortcut: name,
                    output: stdout.trim() || "(no output)",
                });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 6. OPEN URL/FILE IN SPECIFIC APP
// ═══════════════════════════════════════════════

/**
 * Small models write the home folder as "~", "/Users/your_username" or "C:\\Users\\user".
 * When a path under some other home doesn't exist but the same path under the real one
 * does, it meant the real one.
 */
export function resolveHomePath(p: string): string {
    if (/^~(?=[/\\]|$)/.test(p)) return join(homedir(), p.slice(1));
    const m = /^(?:\/Users|\/home|[A-Za-z]:[\\/]Users)[\\/]([^\\/]+)(.*)$/.exec(p);
    if (!m || existsSync(p)) return p;
    const mine = join(homedir(), m[2]);
    return existsSync(mine) ? mine : p;
}

// Folders that are almost never what someone means by "find my file".
const FIND_NOISE = /\/(Library|node_modules|\.git|\.Trash|\.cache|\.npm|DerivedData)\//;

export const findFiles: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "find_files",
            description:
                "Find files or folders anywhere on the Mac instantly through the Spotlight index, by name or by words inside them. Use this (not glob, Finder clicks or shell find) when the user asks for a file without giving its path: 'my resume pdf', 'the invoice from March', 'the Bhai folder'. Returns paths, newest first, the user's own files before system ones. Then use open_in_app to open one.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Part of the name, e.g. 'resume' or 'tax 2025'" },
                    content: {
                        type: "boolean",
                        description: "Also match words inside the files (documents, PDFs, notes). Default false: names only.",
                    },
                    ext: { type: "string", description: "Only this extension, e.g. 'pdf', 'png', 'docx'" },
                    folder: { type: "string", description: "Only inside this folder, e.g. '~/Documents'" },
                    limit: { type: "number", description: "Max results (default 20, max 100)" },
                },
                required: ["query"],
            },
        },
    },

    async handler(input) {
        if (!IS_MAC) {
            return JSON.stringify({
                success: false,
                error: "find_files uses Spotlight (macOS). Use glob with a pattern like '**/*resume*' instead.",
            });
        }
        const query = String(input.query ?? "").trim();
        if (!query) return JSON.stringify({ success: false, error: "Provide 'query'." });
        const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
        const ext = String(input.ext ?? "")
            .replace(/^\./, "")
            .toLowerCase();
        const args = input.content ? [query] : ["-name", query];
        if (input.folder) args.unshift("-onlyin", resolve(resolveHomePath(String(input.folder))));
        try {
            const { stdout } = await execFileAsync("mdfind", args, { timeout: 10_000, maxBuffer: 20 * 1024 * 1024 });
            const home = homedir();
            const hits = stdout
                .split("\n")
                .filter((p) => p && (!ext || extname(p).toLowerCase() === `.${ext}`))
                .slice(0, 2000)
                .map((p) => {
                    let mtime = 0;
                    try {
                        mtime = statSync(p).mtimeMs;
                    } catch {
                        /* gone since indexing */
                    }
                    return { p, mtime, mine: p.startsWith(home) && !FIND_NOISE.test(p) };
                })
                .filter((h) => h.mtime > 0)
                .sort((a, b) => Number(b.mine) - Number(a.mine) || b.mtime - a.mtime);
            return JSON.stringify({
                success: true,
                total: hits.length,
                files: hits.slice(0, limit).map((h) => ({
                    path: h.p,
                    modified: new Date(h.mtime).toISOString().slice(0, 16).replace("T", " "),
                })),
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

export const openInApp: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "open_in_app",
            description:
                "Open a file, folder, or URL in a specific application. If no app is specified, opens with the default app. App deep links do a whole step in one call, no clicking: maps://?daddr=<place> (directions) or maps://?q=<place>, facetime://<number or email>, facetime-audio://<number>, mailto:<to>?subject=..&body=.. (draft), sms:<number>, zoommtg://zoom.us/join?confno=<id>, vscode://file/<abs path>:<line>, shortcuts://run-shortcut?name=<name>. URL-encode values. Settings pages: use open_settings. Websites: use the browser tools.",
            parameters: {
                type: "object",
                properties: {
                    target: {
                        type: "string",
                        description: "File path, folder path, or URL to open",
                    },
                    app: {
                        type: "string",
                        description:
                            "Application name to open with (e.g. 'Preview', 'Visual Studio Code', 'Safari'). If omitted, uses default app.",
                    },
                },
                required: ["target"],
            },
        },
    },

    async handler(input) {
        // Fallback: LLMs often send "path" since other file tools use that param name
        const raw = (input.target || input.path || input.url) as string | undefined;
        const target = raw && !/^[a-z][\w+.-]+:/i.test(raw) ? resolveHomePath(raw) : raw; // URLs pass as-is
        const app = input.app as string | undefined;

        if (!target) {
            return JSON.stringify({
                success: false,
                error: "Missing required parameter: 'target' (file path, folder path, or URL to open)",
            });
        }

        try {
            await nativeOpen(target, app);
            return JSON.stringify({
                success: true,
                opened: target,
                app: app || "default",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
