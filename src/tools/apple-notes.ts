// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Apple Notes Integration ─────────────────────
// JXA-based tool for managing Apple Notes on macOS.
// Supports listing, searching, reading, creating, editing, deleting, moving, and exporting notes.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);

async function runJXA(script: string, timeout = 15000): Promise<string> {
    const tmpFile = join(tmpdir(), `bhai_notes_${Date.now()}.js`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
}

// Simple HTML→Markdown conversion for note bodies
function htmlToMarkdown(html: string): string {
    // &amp; is decoded last, so "&amp;lt;" stays the literal text "&lt;"
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<p[^>]*>/gi, "")
        .replace(/<\/div>/gi, "\n")
        .replace(/<div[^>]*>/gi, "")
        .replace(/<b>|<strong>/gi, "**")
        .replace(/<\/b>|<\/strong>/gi, "**")
        .replace(/<i>|<em>/gi, "_")
        .replace(/<\/i>|<\/em>/gi, "_")
        .replace(/<u>/gi, "__")
        .replace(/<\/u>/gi, "__")
        .replace(/<h1[^>]*>/gi, "# ")
        .replace(/<\/h1>/gi, "\n")
        .replace(/<h2[^>]*>/gi, "## ")
        .replace(/<\/h2>/gi, "\n")
        .replace(/<h3[^>]*>/gi, "### ")
        .replace(/<\/h3>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<\/li>/gi, "\n")
        .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/gi, "")
        .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// Markdown→HTML conversion for creating/editing notes
function markdownToHtml(md: string): string {
    return md
        .replace(/### (.+)/g, "<h3>$1</h3>")
        .replace(/## (.+)/g, "<h2>$1</h2>")
        .replace(/# (.+)/g, "<h1>$1</h1>")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/_(.+?)_/g, "<i>$1</i>")
        .replace(/^- (.+)$/gm, "<li>$1</li>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\n\n/g, "</div><div>")
        .replace(/\n/g, "<br>")
        .replace(/^/, "<div>")
        .replace(/$/, "</div>");
}

function escapeJS(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

export const appleNotesTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "apple_notes",
            description:
                "Manage Apple Notes on macOS: list, search, read, create, edit, delete, move notes between folders, list folders, and export notes. macOS only.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list", "search", "read", "create", "edit", "delete", "move", "list_folders", "export"],
                        description: "Action to perform",
                    },
                    query: {
                        type: "string",
                        description: "Search query (for 'search' action)",
                    },
                    note_name: {
                        type: "string",
                        description: "Note title to operate on (for 'read', 'edit', 'delete', 'move', 'export')",
                    },
                    title: {
                        type: "string",
                        description: "Note title (for 'create' or 'edit')",
                    },
                    body: {
                        type: "string",
                        description: "Note body in markdown (for 'create' or 'edit')",
                    },
                    folder: {
                        type: "string",
                        description: "Folder name (for 'create', 'list', or 'move' source filter)",
                    },
                    target_folder: {
                        type: "string",
                        description: "Target folder (for 'move' action)",
                    },
                    format: {
                        type: "string",
                        enum: ["markdown", "html"],
                        description: "Export format (default: markdown)",
                    },
                    limit: {
                        type: "number",
                        description: "Max notes to return (default: 20 for list/search)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;
        const limit = Math.min(Math.max(1, (input.limit as number) || 20), 100);

        try {
            switch (action) {
                case "list": {
                    const folder = (input.folder as string) || "";
                    const folderFilter = folder
                        ? `const targetFolder = notes.folders.whose({name: "${escapeJS(folder)}"})[0]; const notesList = targetFolder.notes();`
                        : `const notesList = notes.notes();`;
                    const result = await runJXA(
                        `
const notes = Application("Notes");
${folderFilter}
const count = Math.min(notesList.length, ${limit});
const output = [];
for (let i = 0; i < count; i++) {
    const n = notesList[i];
    output.push({
        name: n.name(),
        folder: n.container().name(),
        created: n.creationDate().toISOString(),
        modified: n.modificationDate().toISOString(),
    });
}
JSON.stringify(output);`,
                        20000,
                    );
                    const notes = JSON.parse(result || "[]");
                    return JSON.stringify({ success: true, count: notes.length, notes });
                }

                case "search": {
                    const query = input.query as string;
                    if (!query) return JSON.stringify({ error: "Provide 'query' to search." });
                    const result = await runJXA(
                        `
const notes = Application("Notes");
const q = "${escapeJS(query)}".toLowerCase();
const allNotes = notes.notes();
const output = [];
for (let i = 0; i < allNotes.length && output.length < ${limit}; i++) {
    const n = allNotes[i];
    const name = n.name();
    const body = n.plaintext();
    if (name.toLowerCase().includes(q) || body.toLowerCase().includes(q)) {
        const snippet = body.substring(0, 150).replace(/\\n/g, " ");
        output.push({
            name: name,
            folder: n.container().name(),
            snippet: snippet,
            modified: n.modificationDate().toISOString(),
        });
    }
}
JSON.stringify(output);`,
                        30000,
                    );
                    const notes = JSON.parse(result || "[]");
                    return JSON.stringify({ success: true, count: notes.length, results: notes });
                }

                case "read": {
                    const noteName = input.note_name as string;
                    if (!noteName) return JSON.stringify({ error: "Provide 'note_name' to read." });
                    // gpt-4.1-nano read "task.txt" from Notes (twice): it's a file.
                    if (/\.(txt|md|csv|json|log|pdf|docx?|rtf)$/i.test(noteName.trim()))
                        return JSON.stringify({ error: `${noteName} is a file, not a note: read it with read (its full path).` });
                    const result = await runJXA(
                        `
const notes = Application("Notes");
const found = notes.notes.whose({name: "${escapeJS(noteName)}"})[0];
if (!found) { JSON.stringify({error: "Note not found"}); }
else {
    JSON.stringify({
        name: found.name(),
        folder: found.container().name(),
        body: found.body(),
        plaintext: found.plaintext(),
        created: found.creationDate().toISOString(),
        modified: found.modificationDate().toISOString(),
    });
}`,
                        15000,
                    );
                    const note = JSON.parse(result || '{"error":"Note not found"}');
                    if (note.error) return JSON.stringify({ success: false, error: note.error });
                    // Convert HTML body to markdown for readability
                    note.body_markdown = htmlToMarkdown(note.body);
                    delete note.plaintext;
                    return JSON.stringify({ success: true, ...note });
                }

                case "create": {
                    const title = input.title as string;
                    const body = (input.body as string) || "";
                    if (!title) return JSON.stringify({ error: "Provide 'title' for the note." });
                    const folder = (input.folder as string) || "";
                    const htmlBody = `<h1>${title}</h1>${markdownToHtml(body)}`;
                    const folderTarget = folder
                        ? `const targetFolder = notes.folders.whose({name: "${escapeJS(folder)}"})[0] || notes.defaultAccount().defaultFolder();`
                        : `const targetFolder = notes.defaultAccount().defaultFolder();`;
                    const result = await runJXA(
                        `
const notes = Application("Notes");
${folderTarget}
const newNote = notes.Note({body: "${escapeJS(htmlBody)}"});
targetFolder.notes.push(newNote);
JSON.stringify({name: newNote.name(), folder: targetFolder.name()});`,
                        15000,
                    );
                    const created = JSON.parse(result || "{}");
                    return JSON.stringify({ success: true, action: "create", ...created });
                }

                case "edit": {
                    const noteName = input.note_name as string;
                    if (!noteName) return JSON.stringify({ error: "Provide 'note_name' to edit." });
                    const newTitle = (input.title as string) || "";
                    const newBody = (input.body as string) || "";
                    if (!newTitle && !newBody)
                        return JSON.stringify({ error: "Provide 'title' and/or 'body' to update." });

                    let editScript: string;
                    if (newTitle && newBody) {
                        const htmlBody = `<h1>${newTitle}</h1>${markdownToHtml(newBody)}`;
                        editScript = `found.body = "${escapeJS(htmlBody)}";`;
                    } else if (newBody) {
                        const htmlBody = markdownToHtml(newBody);
                        editScript = `
const currentName = found.name();
found.body = "<h1>" + currentName + "</h1>${escapeJS(htmlBody)}";`;
                    } else {
                        // Title-only change: read current body, replace title
                        editScript = `
const currentBody = found.body();
const stripped = currentBody.replace(/<h1[^>]*>.*?<\\/h1>/i, "");
found.body = "<h1>${escapeJS(newTitle)}</h1>" + stripped;`;
                    }

                    const result = await runJXA(
                        `
const notes = Application("Notes");
const found = notes.notes.whose({name: "${escapeJS(noteName)}"})[0];
if (!found) { JSON.stringify({error: "Note not found"}); }
else {
    ${editScript}
    JSON.stringify({name: found.name(), modified: found.modificationDate().toISOString()});
}`,
                        15000,
                    );
                    const edited = JSON.parse(result || '{"error":"Note not found"}');
                    if (edited.error) return JSON.stringify({ success: false, error: edited.error });
                    return JSON.stringify({ success: true, action: "edit", ...edited });
                }

                case "delete": {
                    const noteName = input.note_name as string;
                    if (!noteName) return JSON.stringify({ error: "Provide 'note_name' to delete." });
                    await runJXA(
                        `
const notes = Application("Notes");
const found = notes.notes.whose({name: "${escapeJS(noteName)}"})[0];
if (found) { notes.delete(found); }
"done";`,
                        15000,
                    );
                    return JSON.stringify({ success: true, action: "delete", note: noteName });
                }

                case "move": {
                    const noteName = input.note_name as string;
                    const targetFolder = input.target_folder as string;
                    if (!noteName) return JSON.stringify({ error: "Provide 'note_name' to move." });
                    if (!targetFolder) return JSON.stringify({ error: "Provide 'target_folder'." });
                    const result = await runJXA(
                        `
const notes = Application("Notes");
const found = notes.notes.whose({name: "${escapeJS(noteName)}"})[0];
if (!found) { JSON.stringify({error: "Note not found"}); }
else {
    const target = notes.folders.whose({name: "${escapeJS(targetFolder)}"})[0];
    if (!target) { JSON.stringify({error: "Folder not found: ${escapeJS(targetFolder)}"}); }
    else {
        notes.move(found, {to: target});
        JSON.stringify({name: found.name(), folder: "${escapeJS(targetFolder)}"});
    }
}`,
                        15000,
                    );
                    const moved = JSON.parse(result || '{"error":"Operation failed"}');
                    if (moved.error) return JSON.stringify({ success: false, error: moved.error });
                    return JSON.stringify({ success: true, action: "move", ...moved });
                }

                case "list_folders": {
                    const result = await runJXA(
                        `
const notes = Application("Notes");
const folders = notes.folders();
const output = folders.map(f => ({
    name: f.name(),
    count: f.notes().length,
}));
JSON.stringify(output);`,
                        15000,
                    );
                    const folders = JSON.parse(result || "[]");
                    return JSON.stringify({ success: true, folders });
                }

                case "export": {
                    const noteName = input.note_name as string;
                    const format = (input.format as string) || "markdown";
                    if (!noteName) return JSON.stringify({ error: "Provide 'note_name' to export." });
                    const result = await runJXA(
                        `
const notes = Application("Notes");
const found = notes.notes.whose({name: "${escapeJS(noteName)}"})[0];
if (!found) { JSON.stringify({error: "Note not found"}); }
else {
    JSON.stringify({
        name: found.name(),
        body: found.body(),
        folder: found.container().name(),
    });
}`,
                        15000,
                    );
                    const note = JSON.parse(result || '{"error":"Note not found"}');
                    if (note.error) return JSON.stringify({ success: false, error: note.error });

                    const content = format === "html" ? note.body : htmlToMarkdown(note.body);
                    const ext = format === "html" ? "html" : "md";
                    const safeName = note.name.replace(/[^a-zA-Z0-9_-]/g, "_");
                    const outPath = join(tmpdir(), `${safeName}.${ext}`);
                    await fs.writeFile(outPath, content, "utf-8");
                    return JSON.stringify({ success: true, action: "export", format, path: outPath, name: note.name });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
