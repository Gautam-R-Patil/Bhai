// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Each test block re-imports the module to reset the module-level `_workspacePath`
// cache. Without this, the first test's resolved path would leak into every
// subsequent test.
async function freshImport() {
    vi.resetModules();
    return await import("./paths.js");
}

describe("paths — getWorkspaceDir priority order", () => {
    const originalEnv = process.env.ATLAS_WORKSPACE;

    beforeEach(() => {
        delete process.env.ATLAS_WORKSPACE;
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.ATLAS_WORKSPACE = originalEnv;
        } else {
            delete process.env.ATLAS_WORKSPACE;
        }
        vi.restoreAllMocks();
    });

    it("priority 1: returns ATLAS_WORKSPACE env var when the directory exists", async () => {
        process.env.ATLAS_WORKSPACE = "/fake/workspace/from-env";
        vi.spyOn(fs, "existsSync").mockImplementation(
            (p) => String(p) === "/fake/workspace/from-env",
        );
        const { getWorkspaceDir } = await freshImport();
        expect(getWorkspaceDir()).toEqual("/fake/workspace/from-env");
    });

    it("priority 1: skips ATLAS_WORKSPACE if the directory doesn't exist", async () => {
        process.env.ATLAS_WORKSPACE = "/fake/workspace/does-not-exist";
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        // Make ALL existsSync calls return false → fall through to mkdirSync
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
        const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
        const { getWorkspaceDir } = await freshImport();
        const result = getWorkspaceDir();
        expect(result).toEqual(path.join("/home/user", "Bhai Files"));
        expect(existsSpy).toHaveBeenCalledWith("/fake/workspace/does-not-exist");
        expect(mkdirSpy).toHaveBeenCalled();
    });

    it("priority 2: returns Desktop location when it exists", async () => {
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        const desktopPath = path.join("/home/user", "Desktop", "Bhai Files");
        vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p) === desktopPath);
        const { getWorkspaceDir } = await freshImport();
        expect(getWorkspaceDir()).toEqual(desktopPath);
    });

    it("priority 2: returns Documents location when Desktop missing", async () => {
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        const documentsPath = path.join("/home/user", "Documents", "Bhai Files");
        vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p) === documentsPath);
        const { getWorkspaceDir } = await freshImport();
        expect(getWorkspaceDir()).toEqual(documentsPath);
    });

    it("priority 2: returns ~/.atlas/files when Desktop + Documents missing", async () => {
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        const atlasFilesPath = path.join("/home/user", ".atlas", "files");
        vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p) === atlasFilesPath);
        const { getWorkspaceDir } = await freshImport();
        expect(getWorkspaceDir()).toEqual(atlasFilesPath);
    });

    it("priority 3: creates ~/Bhai Files when no existing location found", async () => {
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { getWorkspaceDir } = await freshImport();
        const result = getWorkspaceDir();
        const expected = path.join("/home/user", "Bhai Files");
        expect(result).toEqual(expected);
        expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
        expect(logSpy).toHaveBeenCalled();
    });

    it("priority 4: falls back to os.tmpdir() when mkdirSync fails", async () => {
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
            throw new Error("EACCES: permission denied");
        });
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { getWorkspaceDir } = await freshImport();
        expect(getWorkspaceDir()).toEqual("/tmp");
    });

    it("caches the resolved path across repeated calls", async () => {
        process.env.ATLAS_WORKSPACE = "/cached/path";
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getWorkspaceDir } = await freshImport();
        getWorkspaceDir();
        getWorkspaceDir();
        getWorkspaceDir();
        // After the first call the cache hit — existsSync should only be
        // consulted during the first call's priority-1 check, not on repeats.
        expect(existsSpy).toHaveBeenCalledTimes(1);
    });
});

describe("paths — getWorkspaceSubdir", () => {
    beforeEach(() => {
        delete process.env.ATLAS_WORKSPACE;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns path.join(workspace, subdir) and creates it if missing", async () => {
        process.env.ATLAS_WORKSPACE = "/ws";
        const created: string[] = [];
        vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p) === "/ws");
        vi.spyOn(fs, "mkdirSync").mockImplementation((p) => {
            created.push(String(p));
            return undefined;
        });
        const { getWorkspaceSubdir } = await freshImport();
        const result = getWorkspaceSubdir("Foo");
        expect(result).toEqual(path.join("/ws", "Foo"));
        expect(created).toContain(path.join("/ws", "Foo"));
    });

    it("does NOT call mkdirSync when the subdir already exists", async () => {
        process.env.ATLAS_WORKSPACE = "/ws";
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
        const { getWorkspaceSubdir } = await freshImport();
        getWorkspaceSubdir("Foo");
        expect(mkdirSpy).not.toHaveBeenCalled();
    });
});

describe("paths — specific directory helpers", () => {
    beforeEach(() => {
        process.env.ATLAS_WORKSPACE = "/ws";
    });

    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
    });

    it("getImagesDir returns workspace/Images", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getImagesDir } = await freshImport();
        expect(getImagesDir()).toEqual(path.join("/ws", "Images"));
    });

    it("getDocumentsDir returns workspace/Documents", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getDocumentsDir } = await freshImport();
        expect(getDocumentsDir()).toEqual(path.join("/ws", "Documents"));
    });

    it("getDownloadsDir returns workspace/Downloads", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getDownloadsDir } = await freshImport();
        expect(getDownloadsDir()).toEqual(path.join("/ws", "Downloads"));
    });

    it("getScreenshotsDir returns workspace/Screenshots", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getScreenshotsDir } = await freshImport();
        expect(getScreenshotsDir()).toEqual(path.join("/ws", "Screenshots"));
    });

    it("getCodeDir returns workspace/Code", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getCodeDir } = await freshImport();
        expect(getCodeDir()).toEqual(path.join("/ws", "Code"));
    });

    it("getTempDir returns workspace/.temp (dotted)", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getTempDir } = await freshImport();
        expect(getTempDir()).toEqual(path.join("/ws", ".temp"));
    });

    it("getExportsDir returns workspace/Exports", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getExportsDir } = await freshImport();
        expect(getExportsDir()).toEqual(path.join("/ws", "Exports"));
    });

    it("getPresentationsDir returns workspace/Presentations", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { getPresentationsDir } = await freshImport();
        expect(getPresentationsDir()).toEqual(path.join("/ws", "Presentations"));
    });
});

describe("paths — generateFilePath + timestamp format", () => {
    beforeEach(() => {
        process.env.ATLAS_WORKSPACE = "/ws";
    });

    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("timestamp format: replaces `:` and `.` with `-` and truncates to 19 chars", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-03-15T14:22:33.456Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateFilePath } = await freshImport();
        const result = generateFilePath("foo", "txt");
        // ISO would be 2025-03-15T14:22:33.456Z → after replace:
        //   2025-03-15T14-22-33-456Z → sliced to 19 chars = 2025-03-15T14-22-33
        expect(result).toEqual(path.join("/ws", "foo_2025-03-15T14-22-33.txt"));
    });

    it("without subdir, places file in the workspace root", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateFilePath } = await freshImport();
        const result = generateFilePath("foo", "pdf");
        expect(path.dirname(result)).toEqual(path.normalize("/ws"));
    });

    it("with subdir, places file inside workspace/<subdir>", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateFilePath } = await freshImport();
        const result = generateFilePath("data", "csv", "exports");
        expect(path.dirname(result)).toEqual(path.join("/ws", "exports"));
    });

    it("extension is appended as-is (no normalization or dot-prefix stripping)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateFilePath } = await freshImport();
        // A leading dot would produce a double-dot — documents the absence of stripping.
        const result = generateFilePath("foo", ".txt");
        expect(path.basename(result).endsWith("..txt")).toBe(true);
    });
});

describe("paths — generateImagePath", () => {
    beforeEach(() => {
        process.env.ATLAS_WORKSPACE = "/ws";
    });

    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("uses 'image' as the base name when description is omitted", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        const result = generateImagePath();
        expect(path.basename(result).startsWith("image_")).toBe(true);
        expect(result.endsWith(".png")).toBe(true);
    });

    it("slug: truncates description to 30 chars, lowercases, non-alphanumeric → '_'", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        const result = generateImagePath("A Very Long Description That Exceeds Thirty Chars!!!");
        // First 30 chars: "A Very Long Description That E"
        // Replace non-alphanumeric → "A_Very_Long_Description_That_E"
        // Lowercase → "a_very_long_description_that_e"
        expect(path.basename(result).startsWith("a_very_long_description_that_e_")).toBe(true);
    });

    it("places the image in workspace/Images", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        const result = generateImagePath("test");
        expect(path.dirname(result)).toEqual(path.join("/ws", "Images"));
    });

    it("handles unicode → replaces with underscores (non-alphanumeric)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        // 🚀 isn't in [a-zA-Z0-9] so it's replaced.
        const result = generateImagePath("rocket 🚀 launch");
        // "rocket 🚀 launch" → "rocket___launch" (🚀 is 2 code units — becomes "__")
        const base = path.basename(result);
        expect(base.startsWith("rocket")).toBe(true);
        expect(base.match(/[🚀]/)).toBeNull();
    });

    it("handles empty string description", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        // Empty string is falsy → falls back to "image"
        const result = generateImagePath("");
        expect(path.basename(result).startsWith("image_")).toBe(true);
    });
});

describe("paths — generateReportPath", () => {
    beforeEach(() => {
        process.env.ATLAS_WORKSPACE = "/ws";
    });

    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("uses 'report' as base when topic omitted", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateReportPath } = await freshImport();
        const result = generateReportPath();
        expect(path.basename(result).startsWith("report_")).toBe(true);
        expect(result.endsWith(".md")).toBe(true);
    });

    it("slug: truncates topic to 40 chars (larger than image slug)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateReportPath } = await freshImport();
        // Exactly 50 chars — should truncate to 40
        const longTopic = "The Quick Brown Fox Jumped Over The Lazy Dog Yesterday";
        const result = generateReportPath(longTopic);
        const base = path.basename(result);
        // Prefix (pre-underscore-timestamp) should be 40 chars max.
        // Match: <slug>_<timestamp>.md → slug = first part before last 2 underscores + date
        // Simpler: find the first "_2025" (timestamp marker) and measure the slug.
        const slugEnd = base.indexOf("_2025");
        const slug = base.slice(0, slugEnd);
        expect(slug.length).toEqual(40);
    });

    it("places the report in workspace/Documents", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateReportPath } = await freshImport();
        const result = generateReportPath("test");
        expect(path.dirname(result)).toEqual(path.join("/ws", "Documents"));
    });

    it("sanitizes special characters in topic", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateReportPath } = await freshImport();
        const result = generateReportPath("AI/ML: Deep Dive (2025)");
        const base = path.basename(result);
        // Expect "ai_ml__deep_dive__2025_" prefix (various punct. → _)
        expect(base).toMatch(/^ai_ml__deep_dive__2025__/);
    });
});

describe("paths — generateScreenshotPath", () => {
    beforeEach(() => {
        process.env.ATLAS_WORKSPACE = "/ws";
    });

    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("places screenshot in workspace/Screenshots with 'screenshot_' prefix", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-06-01T12:34:56Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateScreenshotPath } = await freshImport();
        const result = generateScreenshotPath();
        expect(path.dirname(result)).toEqual(path.join("/ws", "Screenshots"));
        expect(path.basename(result).startsWith("screenshot_")).toBe(true);
        expect(result.endsWith(".png")).toBe(true);
    });

    it("includes timestamp in the filename", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-06-01T12:34:56Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateScreenshotPath } = await freshImport();
        const result = generateScreenshotPath();
        expect(path.basename(result)).toEqual("screenshot_2025-06-01T12-34-56.png");
    });
});

describe("paths — isWorkspaceConfigured", () => {
    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
    });

    it("returns true when workspace is a real dir (not tmpdir)", async () => {
        process.env.ATLAS_WORKSPACE = "/real/workspace";
        vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
        vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p) === "/real/workspace");
        const { isWorkspaceConfigured } = await freshImport();
        expect(isWorkspaceConfigured()).toBe(true);
    });

    it("returns false when workspace resolves to os.tmpdir() (fallback case)", async () => {
        // No env, no existing default locations, mkdirSync throws → tmpdir fallback
        delete process.env.ATLAS_WORKSPACE;
        vi.spyOn(os, "homedir").mockReturnValue("/home/user");
        vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
            throw new Error("EACCES");
        });
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { isWorkspaceConfigured, getWorkspaceDir } = await freshImport();
        // Sanity: resolved workspace IS tmpdir
        expect(getWorkspaceDir()).toEqual("/tmp");
        expect(isWorkspaceConfigured()).toBe(false);
    });

    it("returns false when workspace path doesn't exist on disk", async () => {
        process.env.ATLAS_WORKSPACE = "/ws";
        vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
        // existsSync true during getAtlasWorkspace (priority 1), false at isWorkspaceConfigured check
        let callCount = 0;
        vi.spyOn(fs, "existsSync").mockImplementation(() => {
            callCount += 1;
            return callCount === 1; // first call (priority 1 check) → true; later → false
        });
        const { isWorkspaceConfigured } = await freshImport();
        expect(isWorkspaceConfigured()).toBe(false);
    });
});

describe("paths — getDataDir", () => {
    const originalDataDir = process.env.ATLAS_DATA_DIR;

    afterEach(() => {
        if (originalDataDir !== undefined) {
            process.env.ATLAS_DATA_DIR = originalDataDir;
        } else {
            delete process.env.ATLAS_DATA_DIR;
        }
        vi.restoreAllMocks();
    });

    it("respects ATLAS_DATA_DIR env var when set", async () => {
        process.env.ATLAS_DATA_DIR = "/var/lib/atlas";
        const { getDataDir } = await freshImport();
        expect(getDataDir()).toEqual("/var/lib/atlas");
    });

    it("defaults to path.resolve('data') when env var is unset", async () => {
        delete process.env.ATLAS_DATA_DIR;
        const { getDataDir } = await freshImport();
        expect(getDataDir()).toEqual(path.resolve("data"));
    });

    it("respects ATLAS_DATA_DIR even when workspace changes", async () => {
        process.env.ATLAS_DATA_DIR = "/custom/data";
        process.env.ATLAS_WORKSPACE = "/some/workspace";
        const { getDataDir, getWorkspaceDir } = await freshImport();
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        // Workspace and data dir are independent — changing one doesn't affect the other.
        expect(getDataDir()).toEqual("/custom/data");
        expect(getWorkspaceDir()).toEqual("/some/workspace");
        delete process.env.ATLAS_WORKSPACE;
    });

    it("treats empty-string env var as falsy → falls back to resolve('data')", async () => {
        process.env.ATLAS_DATA_DIR = "";
        const { getDataDir } = await freshImport();
        expect(getDataDir()).toEqual(path.resolve("data"));
    });
});

describe("paths — slug truncation edge cases", () => {
    beforeEach(() => {
        process.env.ATLAS_WORKSPACE = "/ws";
    });

    afterEach(() => {
        delete process.env.ATLAS_WORKSPACE;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("generateImagePath slug with ONLY special chars → all underscores", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        const result = generateImagePath("!@#$%^&*()");
        // 10 chars, all non-alphanumeric → 10 underscores
        const base = path.basename(result);
        expect(base.startsWith("__________")).toBe(true);
    });

    it("generateReportPath with exactly 40-char topic (no truncation)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateReportPath } = await freshImport();
        const forty = "a".repeat(40);
        const result = generateReportPath(forty);
        const base = path.basename(result);
        expect(base.startsWith(`${forty}_`)).toBe(true);
    });

    it("generateImagePath with topic shorter than 30 chars preserves full slug", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const { generateImagePath } = await freshImport();
        const result = generateImagePath("abc");
        expect(path.basename(result).startsWith("abc_")).toBe(true);
    });
});
