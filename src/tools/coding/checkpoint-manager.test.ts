// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic: point BHAI_WORKSPACE at a temp dir that EXISTS, and resetModules so
// paths.ts re-resolves its CACHED workspace path into the sandbox (other test
// files in the same worker may have already cached the real workspace).
let workspace: string;
let project: string;

beforeEach(() => {
    vi.resetModules();
    workspace = mkdtempSync(join(tmpdir(), "bhai-ws-"));
    project = mkdtempSync(join(tmpdir(), "bhai-proj-"));
    process.env.BHAI_WORKSPACE = workspace;
    delete process.env.BHAI_NO_AUTO_CHECKPOINT;
});
afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    delete process.env.BHAI_WORKSPACE;
    delete process.env.BHAI_NO_AUTO_CHECKPOINT;
});

function gitAvailable(): boolean {
    try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function storeDir(): string {
    return join(workspace, ".bhai-checkpoints");
}
function onlyStore(): string {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dirs = readdirSync(storeDir(), { withFileTypes: true }).filter((e: { isDirectory(): boolean }) =>
        e.isDirectory(),
    );
    return join(storeDir(), dirs[0].name);
}
function shadowLog(gitDir: string): string {
    return execFileSync("git", ["log", "--oneline"], {
        env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: project },
        encoding: "utf-8",
    });
}

describe.runIf(gitAvailable())("checkpoint-manager", () => {
    it("snapshots a project dir into the shadow store, not the project's own .git", async () => {
        const { ensureCheckpoint } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "test");
        expect(existsSync(join(onlyStore(), "HEAD"))).toBe(true);
        expect(shadowLog(onlyStore()).trim().split("\n").length).toBe(1);
        // The project dir got no .git of its own.
        expect(existsSync(join(project, ".git"))).toBe(false);
    });

    it("dedups within the time window (second call is a no-op)", async () => {
        const { ensureCheckpoint } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "first");
        writeFileSync(join(project, "a.txt"), "v2");
        await ensureCheckpoint(project, "second"); // inside 30s window → skipped
        expect(shadowLog(onlyStore()).trim().split("\n").length).toBe(1);
    });

    it("excludes node_modules, .env, and oversized files", async () => {
        const { ensureCheckpoint } = await import("./checkpoint-manager.js");
        mkdirSync(join(project, "node_modules"), { recursive: true });
        writeFileSync(join(project, "node_modules", "junk.js"), "x");
        writeFileSync(join(project, ".env"), "SECRET=1");
        writeFileSync(join(project, "big.bin"), Buffer.alloc(11 * 1024 * 1024));
        writeFileSync(join(project, "keep.txt"), "hello");
        await ensureCheckpoint(project, "test");
        const files = execFileSync("git", ["ls-files"], {
            env: { ...process.env, GIT_DIR: onlyStore(), GIT_WORK_TREE: project },
            encoding: "utf-8",
        });
        expect(files).toContain("keep.txt");
        expect(files).not.toContain("node_modules");
        expect(files).not.toContain(".env");
        expect(files).not.toContain("big.bin");
    });

    it("restoreCheckpoint reverts content and leaves a pre-rollback safety commit", async () => {
        const { ensureCheckpoint, restoreCheckpoint, listCheckpoints } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "v1");
        const sha = listCheckpoints(project)[0].sha;
        // Force a second snapshot past the dedup window.
        writeFileSync(join(project, "a.txt"), "v2");
        const before = listCheckpoints(project).length;
        const res = restoreCheckpoint(project, sha);
        expect(res.success).toBe(true);
        expect(res.safety_sha).toBeTruthy();
        expect(readFileSync(join(project, "a.txt"), "utf-8")).toBe("v1");
        expect(listCheckpoints(project).length).toBeGreaterThan(before); // safety commit added
    });

    it("keeps using a pre-rename .atlas-checkpoints store (never moved), so old checkpoints stay listed", async () => {
        const { ensureCheckpoint, listCheckpoints } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "before rename");
        const { renameSync } = require("node:fs") as typeof import("node:fs");
        renameSync(storeDir(), join(workspace, ".atlas-checkpoints"));
        expect(listCheckpoints(project).map((c) => c.subject)).toEqual([expect.stringContaining("before rename")]);
        expect(existsSync(join(workspace, ".atlas-checkpoints"))).toBe(true);
        expect(existsSync(storeDir())).toBe(false);
    });

    it("rejects an invalid sha", async () => {
        const { ensureCheckpoint, restoreCheckpoint } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "v1");
        expect(restoreCheckpoint(project, "not-a-sha").success).toBe(false);
        expect(restoreCheckpoint(project, "deadbeef").success).toBe(false); // valid form, unknown commit
    });

    it("kill-switch BHAI_NO_AUTO_CHECKPOINT=true creates no store", async () => {
        process.env.BHAI_NO_AUTO_CHECKPOINT = "true";
        const { ensureCheckpoint } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "test");
        expect(existsSync(storeDir()) && require("node:fs").readdirSync(storeDir()).length > 0).toBe(false);
    });

    it("clearAll removes stores and statusReport reflects it", async () => {
        const { ensureCheckpoint, clearAll, statusReport } = await import("./checkpoint-manager.js");
        writeFileSync(join(project, "a.txt"), "v1");
        await ensureCheckpoint(project, "test");
        const { removed } = clearAll();
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(statusReport()).toContain("no snapshots");
    });
});

describe("checkpoint hook registration", () => {
    it("BUILTIN_HOOKS has the auto-checkpoint PreToolUse entry that passes through", async () => {
        const { BUILTIN_HOOKS } = await import("../../hooks/built-in.js");
        const entry = BUILTIN_HOOKS.PreToolUse?.find((h) => h.name === "builtin:auto-checkpoint");
        expect(entry).toBeTruthy();
        expect(entry?.matcher).toBe("^(edit|write|append_file)$");
        expect(typeof entry?.handler).toBe("function");
        const result = await entry?.handler?.({ tool: "write", input: { file_path: "/nonexistent/x.txt" } });
        expect(result).toBeNull(); // passthrough — never blocks
    });
});
