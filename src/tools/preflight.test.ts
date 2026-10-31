// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { preflight } from "./preflight.js";

const TMP = join(tmpdir(), `bhai-preflight-test-${Date.now()}`);
const EXISTING_FILE = join(TMP, "exists.txt");
const MISSING_FILE = join(TMP, "missing.txt");

beforeAll(() => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(EXISTING_FILE, "hello");
});

afterAll(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {
        /* */
    }
});

describe("preflight — file-path tools", () => {
    it("read: absent file → returns hint", () => {
        const hint = preflight("read", { file_path: MISSING_FILE });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/does not exist/);
    });

    it("read: present file → null", () => {
        expect(preflight("read", { file_path: EXISTING_FILE })).toBeNull();
    });

    it("read: relative path → hint about absolute", () => {
        const hint = preflight("read", { file_path: "relative/path.txt" });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/absolute path/i);
    });

    it("write: parent dir missing → hint", () => {
        const hint = preflight("write", { file_path: "/nonexistent_dir_xyz_123/foo.txt" });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/parent directory/i);
    });

    it("write: parent dir exists → null", () => {
        const hint = preflight("write", { file_path: join(TMP, "new-file.txt") });
        expect(hint).toBeNull();
    });

    it("delete_file: already absent → hint ('no action needed')", () => {
        const hint = preflight("delete_file", { file_path: MISSING_FILE });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/already absent/i);
    });

    it("edit: absent file → hint", () => {
        const hint = preflight("edit", { file_path: MISSING_FILE });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/does not exist/);
    });
});

describe("preflight — URL tools", () => {
    it("browser_navigate: missing scheme → hint", () => {
        const hint = preflight("browser_navigate", { url: "example.com/foo" });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/https?/);
    });

    it("browser_navigate: valid https → null", () => {
        expect(preflight("browser_navigate", { url: "https://example.com" })).toBeNull();
    });

    it("web_search is NOT in URL set (takes query, not URL)", () => {
        // Regression: web_search used to be mis-listed as URL-required
        expect(preflight("web_search", { query: "anything" })).toBeNull();
    });
});

describe("preflight — shell tools", () => {
    it("shell_exec: empty command → hint", () => {
        expect(preflight("shell_exec", { command: "" })).toBeNull(); // empty is pickStringArg-skipped
        expect(preflight("shell_exec", { command: "   " })).not.toBeNull();
    });

    it("shell_exec: catastrophic 'rm -rf /' → refuses", () => {
        const hint = preflight("shell_exec", { command: "rm -rf /" });
        expect(hint).not.toBeNull();
        expect(hint!.reason).toMatch(/catastrophic|rm -rf \//i);
    });

    it("shell_exec: 'rm -fr /' (reversed flag order) → also refuses", () => {
        const hint = preflight("shell_exec", { command: "rm -fr /" });
        expect(hint).not.toBeNull();
    });

    it("shell_exec: 'rm -rf --no-preserve-root /' → also refuses", () => {
        const hint = preflight("shell_exec", { command: "rm -rf --no-preserve-root /" });
        expect(hint).not.toBeNull();
    });

    it("shell_exec: 'rm -rf /*' → also refuses", () => {
        const hint = preflight("shell_exec", { command: "rm -rf /*" });
        expect(hint).not.toBeNull();
    });

    it("shell_exec: 'rm -rf /tmp/something' does NOT trigger the catch-all", () => {
        expect(preflight("shell_exec", { command: "rm -rf /tmp/bhai-cache" })).toBeNull();
        expect(preflight("shell_exec", { command: "rm -rf /home/user/build" })).toBeNull();
    });

    it("shell_exec: normal command → null", () => {
        expect(preflight("shell_exec", { command: "ls -la" })).toBeNull();
        expect(preflight("shell_exec", { command: "rm -rf /tmp/my-cache" })).toBeNull();
    });
});

describe("preflight — fail-open", () => {
    it("unknown tool → null (never blocks)", () => {
        expect(preflight("some_random_tool", { foo: "bar" })).toBeNull();
    });

    it("missing args → null", () => {
        expect(preflight("read", {})).toBeNull();
    });

    it("malformed args shape → null (doesn't throw)", () => {
        expect(() => preflight("read", { file_path: 123 as unknown as string })).not.toThrow();
    });
});

describe("preflight — ~ paths", () => {
    it("expands ~/ in place instead of refusing it as relative", async () => {
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const args: Record<string, unknown> = { file_path: "~/no-such-file-for-preflight.txt" };
        const hint = preflight("read", args);
        expect(args.file_path).toBe(join(homedir(), "no-such-file-for-preflight.txt"));
        expect(hint?.reason).toMatch(/does not exist/); // checked as the real path, not refused as relative
        const bare: Record<string, unknown> = { file_path: "~" };
        preflight("write", bare);
        expect(bare.file_path).toBe("~"); // a bare ~ isn't turned into the whole home folder
    });
});
