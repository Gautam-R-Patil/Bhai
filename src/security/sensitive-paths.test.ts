// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { isSensitivePath } from "./sensitive-paths.js";

describe("isSensitivePath — /proc and /sys (Linux env/memory exfiltration)", () => {
    // /proc/self/environ dumps the process env (every .env token); /proc/self/mem
    // is its raw memory (decrypted vault values, session keys). The deny is
    // path-based, so it fires on every platform regardless of whether /proc exists.
    it("denies /proc/self/environ", () => {
        expect(isSensitivePath("/proc/self/environ").denied).toBe(true);
    });
    it("denies /proc/<pid>/mem and /proc/<pid>/environ", () => {
        expect(isSensitivePath("/proc/1/mem").denied).toBe(true);
        expect(isSensitivePath("/proc/12345/environ").denied).toBe(true);
    });
    it("denies anything under /sys", () => {
        expect(isSensitivePath("/sys/kernel/debug").denied).toBe(true);
    });
    it("does not over-match a sibling like /procfoo", () => {
        // Boundary guard: /proc must not deny an unrelated path that merely shares
        // the prefix string.
        expect(isSensitivePath("/procfoo/bar").denied).toBe(false);
    });
    it("still allows an ordinary path", () => {
        expect(isSensitivePath("/tmp/ok.txt").denied).toBe(false);
    });
});

describe("isSensitivePath — Bhai's own state and other apps' credentials", () => {
    it("denies both ~/.bhai and the pre-rename ~/.atlas", async () => {
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        expect(isSensitivePath(join(homedir(), ".bhai", "hooks.json")).denied).toBe(true);
        expect(isSensitivePath(join(homedir(), ".atlas", "data", "tool-analytics.json")).denied).toBe(true);
    });
    it("denies a state root moved by BHAI_HOME", () => {
        const before = process.env.BHAI_HOME;
        process.env.BHAI_HOME = "/srv/bhai-state";
        try {
            expect(isSensitivePath("/srv/bhai-state/data/forge-persist-key").denied).toBe(true);
        } finally {
            if (before === undefined) delete process.env.BHAI_HOME;
            else process.env.BHAI_HOME = before;
        }
    });
    it("denies the data dir (memory.db, its -wal, the WhatsApp session) but not saved tool outputs", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const data = mkdtempSync(join(tmpdir(), "sp-data-"));
        const before = process.env.BHAI_DATA_DIR;
        process.env.BHAI_DATA_DIR = data;
        try {
            for (const f of ["memory.db", "memory.db-wal", "chat-history.jsonl", "whatsapp-auth/creds.json", "browser-profile/Default/Cookies"])
                expect(isSensitivePath(join(data, f)).denied, f).toBe(true);
            mkdirSync(join(data, "tool-outputs", "turn-1"), { recursive: true });
            writeFileSync(join(data, "memory.db"), "");
            expect(isSensitivePath(join(data, "tool-outputs", "turn-1", "web_read-x.txt")).denied).toBe(false);
            expect(isSensitivePath(join(data, "research", "r.md")).denied).toBe(false);
            // A link planted in tool-outputs resolves to what it points at.
            symlinkSync(join(data, "memory.db"), join(data, "tool-outputs", "turn-1", "link.txt"));
            expect(isSensitivePath(join(data, "tool-outputs", "turn-1", "link.txt")).denied).toBe(true);
        } finally {
            if (before === undefined) delete process.env.BHAI_DATA_DIR;
            else process.env.BHAI_DATA_DIR = before;
        }
    });

    it("denies other apps' credential stores", async () => {
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const h = homedir();
        for (const p of [".config/gh/hosts.yml", "Library/Keychains/login.keychain-db", "Library/Messages/chat.db",
            "Library/Application Support/Google/Chrome/Default/Login Data", ".mozilla/firefox/x/cookies.sqlite"])
            expect(isSensitivePath(join(h, p)).denied, p).toBe(true);
        expect(isSensitivePath(join(h, "Documents", "notes.txt")).denied).toBe(false);
    });
});

describe("shellNamesBhaiState", () => {
    it("catches the data folder however the path is written, not its readable subfolders", async () => {
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const { shellNamesBhaiState } = await import("./sensitive-paths.js");
        const data = join(homedir(), "Library", "Application Support", "bhai-desktop", "data");
        const before = process.env.BHAI_DATA_DIR;
        process.env.BHAI_DATA_DIR = data;
        try {
            expect(shellNamesBhaiState(`cat "${data}/memory.db"`)).not.toBeNull();
            expect(shellNamesBhaiState("wc -l ~/Library/Application\\ Support/bhai-desktop/data/chat-history.jsonl")).not.toBeNull();
            expect(shellNamesBhaiState("tar czf /tmp/x.tgz $HOME/Library/Application\\ Support/bhai-desktop/data/whatsapp-auth")).not.toBeNull();
            expect(shellNamesBhaiState(`ls "${data}"`)).not.toBeNull();
            expect(shellNamesBhaiState(`wc -l "${data}/tool-outputs/turn-1/web_read-x.txt"`)).toBeNull();
            expect(shellNamesBhaiState(`ls "${data}2/notes"`)).toBeNull(); // a sibling folder
            expect(shellNamesBhaiState("ls ~/Documents")).toBeNull();
            expect(shellNamesBhaiState("cat memory.db", data)).not.toBeNull(); // run from inside it
            expect(shellNamesBhaiState("tail -5 x.log", join(data, "process-logs"))).toBeNull();
            expect(isSensitivePath(join(data, "process-logs", "bg-1.log")).denied).toBe(false); // shell_exec_background's log_file
        } finally {
            if (before === undefined) delete process.env.BHAI_DATA_DIR;
            else process.env.BHAI_DATA_DIR = before;
        }
    });
});
