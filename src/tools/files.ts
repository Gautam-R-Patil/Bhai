// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Legacy file primitives ──────────────────────
// Reading, writing, and filename-based search were moved to the new
// coding tools in `src/tools/coding/` (`read`, `write`, `edit`, `append_file`,
// `grep`, `glob`). This file retains the two primitives that aren't part
// of the coding suite: directory listing and file deletion.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../security/allowlist.js";
import { auditLog } from "../security/audit-log.js";
import { isSensitivePath } from "../security/sensitive-paths.js";
import { forget as forgetRead } from "./coding/read-registry.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Constants ─────────────────────────────────

const MAX_LIST = 100;
const HOME_DIR = os.homedir();

// ── Helpers ──────────────────────────────────

function isOutsideHome(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return !resolved.startsWith(HOME_DIR + path.sep) && resolved !== HOME_DIR;
}

// ── List Directory ────────────────────────────

export const listDirectory: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_directory",
            description:
                "List files and directories at a path, newest first, with each one's size and last-modified time. For the newest file of a kind ('the newest PDF'), pass ext and take the first item.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Directory path" },
                    ext: { type: "string", description: "Only files with this extension, e.g. 'pdf'" },
                },
                required: ["path"],
            },
        },
    },
    async handler(input) {
        const dirPath = path.resolve(input.path as string);
        if (!isPathAllowed(dirPath)) {
            const reason = getPathBlockedReason(dirPath) ?? "Path not allowed.";
            return JSON.stringify({ error: reason });
        }
        try {
            // Newest first, with dates: "the newest PDF in Downloads" was unanswerable from
            // names alone, and the cap could cut the newest file off a big folder.
            // ponytail: stats at most 5,000 entries (~50ms); past that "newest" is among those.
            const ext = String(input.ext ?? "")
                .replace(/^\./, "")
                .toLowerCase();
            const all = fs
                .readdirSync(dirPath, { withFileTypes: true })
                .filter((e) => !ext || (e.isFile() && path.extname(e.name).toLowerCase() === `.${ext}`))
                .slice(0, 5000)
                .map((e) => {
                    let st: fs.Stats | undefined;
                    try {
                        st = fs.statSync(path.join(dirPath, e.name));
                    } catch {
                        /* broken link, or gone since readdir */
                    }
                    return { e, st };
                });
            all.sort((a, b) => (b.st?.mtimeMs ?? 0) - (a.st?.mtimeMs ?? 0));
            const items = all.slice(0, MAX_LIST).map(({ e, st }) => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : "file",
                size: e.isFile() ? st?.size : undefined,
                modified: st ? new Date(st.mtimeMs).toISOString().slice(0, 16).replace("T", " ") : undefined,
            }));
            // The count first: a long listing gets cut short in the model's context, and a
            // total at the end was lost ("how many PDFs?" answered 32 of 131).
            // Per kind: asked to count the .txt files, gpt-4.1-nano counted every file.
            const kinds: Record<string, number> = {};
            if (!ext)
                for (const { e } of all) {
                    const k = e.isDirectory() ? "folders" : path.extname(e.name).slice(1).toLowerCase() || "no extension";
                    kinds[k] = (kinds[k] ?? 0) + 1;
                }
            // by_kind first: given count 4 and by_kind {txt: 3}, nano still answered 4.
            return JSON.stringify({
                success: true,
                ...(Object.keys(kinds).length > 1 ? { by_kind: kinds } : {}),
                count: all.length,
                ...(all.length > MAX_LIST ? { shown: MAX_LIST, note: `Newest ${MAX_LIST} shown.` } : {}),
                items,
            });
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }
    },
};

// ── Move / Copy / Rename / New Folder ─────────
// Without it "move the PDF into Invoices" meant Finder drags or shell mv. Never
// overwrites: an existing destination is refused, so nothing is lost.

/** Why a path may not be moved/copied/created, or undefined. */
/** Extensions that name a file, not a folder. */
const FILE_EXT = /^\.(txt|md|pdf|docx?|xlsx?|pptx?|csv|json|png|jpe?g|heic|gif|zip|html?|rtf|log|js|ts|py)$/i;

/** Formats whose bytes differ: a new extension alone doesn't make one into another. */
const CONVERTIBLE = new Set(["png", "jpg", "jpeg", "heic", "tiff", "tif", "gif", "bmp", "webp", "pdf"]);

export function manageRefusal(p: string, source: boolean): string | undefined {
    if (!isPathAllowed(p)) return getPathBlockedReason(p) ?? `Path not allowed: ${p}`;
    if (isProtectedPath(p)) return `"${p}" is part of Bhai's own code and is write-protected.`;
    const sensitive = source ? isSensitivePath(p) : { denied: false, reason: "" };
    return sensitive.denied ? `Refused: ${sensitive.reason}` : undefined;
}

export const fileManage: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "file_manage",
            description:
                "Move, copy or rename files and folders, or make a new folder. Use this (not Finder or shell) for 'move X into Y', 'rename X to Y', 'copy X to Y', 'make a folder called Z'. Never overwrites.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["move", "copy", "rename", "new_folder"] },
                    paths: {
                        type: "array",
                        items: { type: "string" },
                        description: "Files/folders to move, copy or rename (rename: one). new_folder: the folder to create.",
                    },
                    destination: {
                        type: "string",
                        description:
                            "move/copy: the folder to put them in (or a full new path for one item). rename: the new name.",
                    },
                },
                required: ["action", "paths"],
            },
        },
    },
    async handler(input) {
        const action = String(input.action ?? "");
        // gpt-4.1-nano sent action "write" seven times, each told only "Provide 'paths'".
        const elsewhere: Record<string, string> = {
            write: "write (a new file) or append_file",
            create_file: "write",
            append: "append_file",
            zip: "compress_files",
            unzip: "compress_files",
            delete: "trash_manager (recoverable) or delete_file",
            merge: "pdf_edit",
            convert: "image_edit",
            resize: "image_edit",
        };
        if (elsewhere[action])
            return JSON.stringify({ success: false, error: `file_manage doesn't ${action}: use ${elsewhere[action]}.` });
        if (!["move", "copy", "rename", "new_folder"].includes(action))
            return JSON.stringify({ success: false, error: "action must be move, copy, rename or new_folder." });
        const raw = input.paths ?? (input as { path?: unknown }).path;
        const paths = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((p) => path.resolve(String(p).trim()));
        if (!paths.length) return JSON.stringify({ success: false, error: "Provide 'paths'." });
        auditLog("file_manage", { action, paths, destination: input.destination });

        if (action === "new_folder") {
            // Models put the new folder in destination and its parent in paths.
            const made = input.destination ? [path.resolve(String(input.destination))] : paths;
            const refused = made.map((p) => manageRefusal(p, false)).find(Boolean);
            if (refused) return JSON.stringify({ success: false, error: refused });
            // gpt-4.1-nano made a folder named count.txt, then couldn't write the file.
            const fileName = made.find((p) => FILE_EXT.test(path.extname(p)));
            if (fileName)
                return JSON.stringify({
                    success: false,
                    error: `${path.basename(fileName)} is a file name, not a folder: to create the file use write.`,
                });
            const file = made.find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
            if (file) return JSON.stringify({ success: false, error: `A file already has that name: ${file}` });
            for (const p of made) fs.mkdirSync(p, { recursive: true });
            return JSON.stringify({ success: true, action, created: made });
        }
        const dest = String(input.destination ?? "").trim();
        if (!dest) return JSON.stringify({ success: false, error: "Provide 'destination'." });
        if (action === "rename" && paths.length !== 1)
            return JSON.stringify({ success: false, error: "rename takes one path." });

        // Where each item ends up: rename keeps the folder; an existing folder receives the items.
        // "a.pdf" moved to ".../PDFs" (not there yet, no extension) means into a new folder
        // PDFs: taken as a new name, gpt-4.1-nano's move turned the PDF into a file named PDFs.
        const d = path.resolve(dest);
        const newFolder =
            action !== "rename" &&
            !fs.existsSync(d) &&
            !path.extname(d) &&
            (paths.length > 1 || !!path.extname(paths[0]));
        const targets = paths.map((src) => {
            if (action === "rename") return path.join(path.dirname(src), path.basename(dest));
            const isDir = newFolder || (fs.existsSync(d) && fs.statSync(d).isDirectory());
            return isDir || paths.length > 1 ? path.join(d, path.basename(src)) : d;
        });
        // Everything is checked before anything moves.
        for (const [i, src] of paths.entries()) {
            const to = targets[i];
            // "Convert photo.png to a JPG": gpt-4.1-nano renamed it photo.jpg, PNG bytes inside.
            const [from, into] = [path.extname(src), path.extname(to)].map((e) => e.slice(1).toLowerCase());
            if (from !== into && CONVERTIBLE.has(from) && CONVERTIBLE.has(into))
                return JSON.stringify({
                    success: false,
                    error: `Renaming .${from} to .${into} doesn't convert it: use image_edit (action convert) for images.`,
                });
            if (!fs.existsSync(src)) return JSON.stringify({ success: false, error: `Not found: ${src}` });
            const refused = manageRefusal(src, true) ?? manageRefusal(to, false);
            if (refused) return JSON.stringify({ success: false, error: refused });
            if (fs.existsSync(to)) return JSON.stringify({ success: false, error: `Already exists, not replaced: ${to}` });
            if (to.startsWith(src + path.sep)) return JSON.stringify({ success: false, error: `Can't put ${src} inside itself.` });
            if (!fs.existsSync(path.dirname(to)) && !(newFolder && path.dirname(to) === d && fs.existsSync(path.dirname(d))))
                return JSON.stringify({ success: false, error: `No such folder: ${path.dirname(to)} (make it with new_folder first)` });
        }
        const done: { from: string; to: string }[] = [];
        try {
            if (newFolder) fs.mkdirSync(d);
            for (const [i, src] of paths.entries()) {
                if (action === "copy") fs.cpSync(src, targets[i], { recursive: true, errorOnExist: true, force: false });
                else {
                    try {
                        fs.renameSync(src, targets[i]);
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
                        // Another disk: copy, then remove the original.
                        fs.cpSync(src, targets[i], { recursive: true, errorOnExist: true, force: false });
                        fs.rmSync(src, { recursive: true });
                    }
                    forgetRead(src);
                }
                done.push({ from: src, to: targets[i] });
            }
            return JSON.stringify({ success: true, action, ...(newFolder ? { made_folder: d } : {}), done });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message, ...(done.length ? { done } : {}) });
        }
    },
};

// ── Delete File ───────────────────────────────

export const deleteFile: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "delete_file",
            description: "Delete a file. Requires confirmation for safety.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path to delete" },
                },
                required: ["path"],
            },
        },
    },
    async handler(input) {
        const filePath = path.resolve(input.path as string);
        auditLog("file_delete", { path: filePath });
        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? "Path not allowed.";
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(filePath)) {
            return JSON.stringify({
                error: `Deleting "${filePath}" is not allowed — this path is part of the bot's own codebase and is write-protected.`,
            });
        }
        const sensitive = isSensitivePath(filePath);
        if (sensitive.denied) return JSON.stringify({ error: `Refused to delete it: ${sensitive.reason}` });
        try {
            fs.unlinkSync(filePath);
            forgetRead(filePath);

            const warning = isOutsideHome(filePath)
                ? `Note: This file was outside your home directory (${HOME_DIR}). Ensure this was intentional.`
                : undefined;

            return JSON.stringify({ success: true, deleted: filePath, ...(warning ? { warning } : {}) });
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }
    },
};
