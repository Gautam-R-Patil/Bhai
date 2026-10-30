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
    it("denies the data dir (memory.db, its -wal, the WhatsApp session) but not saved tool outputs", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const data = mkdtempSync(join(tmpdir(), "sp-data-"));
        const before = process.env.ATLAS_DATA_DIR;
        process.env.ATLAS_DATA_DIR = data;
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
            if (before === undefined) delete process.env.ATLAS_DATA_DIR;
            else process.env.ATLAS_DATA_DIR = before;
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
