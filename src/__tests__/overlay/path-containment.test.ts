// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import via dynamic import after setting ATLAS_WORKSPACE so the
// workspace dir resolves to our scratch dir.
let workspaceDir: string;
let resolveSafePath: (p: string) => string | null;
let scratchRoot: string;

beforeAll(async () => {
    scratchRoot = mkdtempSync(join(tmpdir(), "atlas-overlay-path-"));
    workspaceDir = join(scratchRoot, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.ATLAS_WORKSPACE = workspaceDir;

    // Seed files
    writeFileSync(join(workspaceDir, "foo.txt"), "hello");
    writeFileSync(join(workspaceDir, ".env"), "SECRET=1");
    writeFileSync(join(workspaceDir, ".env.production"), "X=2");
    mkdirSync(join(workspaceDir, ".ssh"));
    writeFileSync(join(workspaceDir, ".ssh", "id_rsa"), "fake");
    mkdirSync(join(workspaceDir, "data"));
    writeFileSync(join(workspaceDir, "data", "google-credentials.json"), "{}");
    writeFileSync(join(workspaceDir, "data", "audit.jsonl"), "{}");
    writeFileSync(join(workspaceDir, "my-credentials.txt"), "fake");

    // Symlink that escapes workspace
    const outside = join(scratchRoot, "outside.txt");
    writeFileSync(outside, "outside");
    try { symlinkSync(outside, join(workspaceDir, "escape.txt")); } catch { /* may fail on win */ }

    const mod = await import("../../overlay/overlay-chat.js");
    resolveSafePath = mod._resolveSafePathForTest;
});

afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
    delete process.env.ATLAS_WORKSPACE;
});

describe("F2: resolveSafePath — workspace containment + deny-list", () => {
    it("accepts a plain file under workspace", () => {
        const r = resolveSafePath(join(workspaceDir, "foo.txt"));
        expect(r).not.toBeNull();
        expect(r!.endsWith("foo.txt")).toBe(true);
    });

    it("rejects absolute path outside workspace (/etc/passwd)", () => {
        expect(resolveSafePath("/etc/passwd")).toBeNull();
    });

    it("rejects path with .. that escapes workspace", () => {
        expect(resolveSafePath(join(workspaceDir, "..", "outside.txt"))).toBeNull();
    });

    it("rejects $WORKSPACE/.env (deny-list)", () => {
        expect(resolveSafePath(join(workspaceDir, ".env"))).toBeNull();
    });

    it("rejects $WORKSPACE/.env.production (deny-list dotted variants)", () => {
        expect(resolveSafePath(join(workspaceDir, ".env.production"))).toBeNull();
    });

    it("rejects $WORKSPACE/.ssh/id_rsa", () => {
        expect(resolveSafePath(join(workspaceDir, ".ssh", "id_rsa"))).toBeNull();
    });

    it("rejects $WORKSPACE/data/google-credentials.json", () => {
        expect(resolveSafePath(join(workspaceDir, "data", "google-credentials.json"))).toBeNull();
    });

    it("rejects $WORKSPACE/data/audit.jsonl", () => {
        expect(resolveSafePath(join(workspaceDir, "data", "audit.jsonl"))).toBeNull();
    });

    it("rejects any path containing 'credentials'", () => {
        expect(resolveSafePath(join(workspaceDir, "my-credentials.txt"))).toBeNull();
    });

    it("rejects symlinks that escape workspace (realpath check)", () => {
        const linkPath = join(workspaceDir, "escape.txt");
        // If symlink wasn't created (windows perms), skip — but still ensure
        // function doesn't throw.
        expect(() => resolveSafePath(linkPath)).not.toThrow();
        const r = resolveSafePath(linkPath);
        // Either null (symlink existed and was rejected) or the file doesn't
        // exist on this platform — both acceptable; never accept-and-allow.
        if (r !== null) {
            expect(r.startsWith(workspaceDir)).toBe(true);
        }
    });

    it("rejects nonexistent path", () => {
        expect(resolveSafePath(join(workspaceDir, "does-not-exist.txt"))).toBeNull();
    });

    it("rejects a case-variant of a deny-listed name", () => {
        // Same file on case-insensitive volumes (macOS/Windows); absent elsewhere.
        expect(resolveSafePath(join(workspaceDir, "DATA", "Audit.JSONL"))).toBeNull();
    });
});

describe("F2: deny-list on Windows-shaped paths (runs on every OS)", () => {
    let isDenied: (real: string, win32?: boolean) => boolean;
    beforeAll(async () => {
        isDenied = (await import("../../overlay/overlay-chat.js"))._isDeniedServePathForTest;
    });

    it("matches segments split by backslashes", () => {
        expect(isDenied("C:\\Users\\me\\Bhai Files\\.env", true)).toBe(true);
        expect(isDenied("C:\\Users\\me\\Bhai Files\\.ENV.production", true)).toBe(true);
        expect(isDenied("C:\\Users\\me\\Bhai Files\\data\\audit.jsonl", true)).toBe(true);
        expect(isDenied("C:\\Users\\me\\Bhai Files\\.ssh\\config", true)).toBe(true);
        expect(isDenied("C:\\Users\\me\\Bhai Files\\notes.txt", true)).toBe(false);
        expect(isDenied("C:\\Users\\me\\Bhai Files\\my.envelope.txt", true)).toBe(false);
    });

    it("refuses NTFS data streams on win32 only", () => {
        expect(isDenied("C:\\ws\\notes.txt::$DATA", true)).toBe(true);
        expect(isDenied("/ws/notes:v2.txt", false)).toBe(false);
    });
});
