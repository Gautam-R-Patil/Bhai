// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Keys, the vault and Bhai's own data never leave the machine: not through send_file,
// not inside a zip, not as grep output. (HOME is a temp folder in tests; see vitest.setup.ts.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const home = os.homedir();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-outbound-data-"));
process.env.BHAI_DATA_DIR = dataDir;
fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "-----BEGIN KEY-----");
fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
fs.writeFileSync(path.join(home, "Documents", "report.pdf"), "pdf");
fs.writeFileSync(path.join(home, "Documents", "vault.enc"), "secret");
fs.writeFileSync(path.join(dataDir, "google-credentials.json"), '{"client_secret":"zzz-findme"}');
fs.mkdirSync(path.join(dataDir, "tool-outputs"), { recursive: true });
fs.writeFileSync(path.join(dataDir, "tool-outputs", "notes.txt"), "zzz-findme in a saved tool output");

const { outboundFileRefusal } = await import("./sensitive-paths.js");
const { sendFileTool, setTelegramContext } = await import("../tools/send-file.js");
const { grep } = await import("../tools/coding/grep.js");

describe("files that never leave", () => {
    it("refuses keys, encrypted app files and folders that hold them; allows ordinary files", () => {
        expect(outboundFileRefusal(path.join(home, ".ssh", "id_rsa"))).toMatch(/Refused/);
        expect(outboundFileRefusal("~/.ssh/id_rsa")).toMatch(/Refused/);
        expect(outboundFileRefusal(path.join(home, "Documents", "vault.enc"))).toMatch(/Refused/);
        expect(outboundFileRefusal(home)).toMatch(/contains/); // zipping ~ would sweep in ~/.ssh
        expect(outboundFileRefusal(path.join(dataDir, "google-credentials.json"))).toMatch(/Refused/);
        expect(outboundFileRefusal(path.join(home, "Documents", "report.pdf"))).toBeNull();
        expect(outboundFileRefusal(path.join(home, "Documents"))).toBeNull();
    });

    it("send_file refuses before anything is read", async () => {
        setTelegramContext({ api: {} }, 1); // a chat to send to; the empty api would throw if reached
        const out = JSON.parse(await sendFileTool.handler({ file_path: path.join(home, ".ssh", "id_rsa") }));
        expect(out.error).toMatch(/Refused/);
    });

    it("grep refuses Bhai's data dir; its saved tool outputs stay searchable", async () => {
        const out = await grep.handler({ pattern: "zzz-findme", path: dataDir, output_mode: "files_with_matches" });
        expect(out).toMatch(/Refusing/);
        expect(out).not.toContain("google-credentials.json");
        const saved = await grep.handler({ pattern: "zzz-findme", path: path.join(dataDir, "tool-outputs"), output_mode: "files_with_matches" });
        expect(saved).toContain("notes.txt");
    });

    // The hit's file was the text before the first ':', so "C:\..." on Windows (or a folder
    // named "x:y") was checked as "C" and every line passed.
    it("grep drops hits from a sensitive folder whose path holds a colon", async () => {
        const root = fs.mkdtempSync(path.join(home, "grep-colon-"));
        const state = path.join(root, "x:y");
        fs.mkdirSync(state);
        fs.writeFileSync(path.join(state, "session.json"), "zzz-colon owner token");
        fs.writeFileSync(path.join(root, "ok.txt"), "zzz-colon fine");
        process.env.BHAI_USER_DATA_DIR = state;
        try {
            for (const output_mode of ["content", "count"]) {
                const out = await grep.handler({ pattern: "zzz-colon", path: root, output_mode });
                expect(out).not.toContain("session.json");
                expect(out).toContain("ok.txt");
            }
            expect(JSON.parse(await grep.handler({ pattern: "zzz-colon", path: root, output_mode: "content" })).content).toBe(
                `${path.join(root, "ok.txt")}:1:zzz-colon fine`,
            );
        } finally {
            delete process.env.BHAI_USER_DATA_DIR;
        }
    });
});
