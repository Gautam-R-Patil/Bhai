// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    atomicJsonWrite,
    atomicReplace,
    atomicTextWrite,
    baseUrlHost,
    baseUrlHostMatches,
    envBool,
    envInt,
    isTruthy,
    normalizeProxyUrl,
    safeJsonParse,
} from "./atomic-io.js";

let tmpRoot: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-atomic-io-"));
});

afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("atomicTextWrite", () => {
    it("creates a new file with the given text", async () => {
        const target = path.join(tmpRoot, "data.txt");
        await atomicTextWrite(target, "hello");
        expect(fs.readFileSync(target, "utf8")).toBe("hello");
    });

    it("overwrites an existing file atomically (no partial state)", async () => {
        const target = path.join(tmpRoot, "data.txt");
        fs.writeFileSync(target, "old");
        await atomicTextWrite(target, "new");
        expect(fs.readFileSync(target, "utf8")).toBe("new");
    });

    it("creates parent directories if missing", async () => {
        const target = path.join(tmpRoot, "a", "b", "c", "data.txt");
        await atomicTextWrite(target, "deep");
        expect(fs.readFileSync(target, "utf8")).toBe("deep");
    });

    it("leaves no .tmp files behind after a successful write", async () => {
        const target = path.join(tmpRoot, "data.txt");
        await atomicTextWrite(target, "clean");
        const leftovers = fs
            .readdirSync(tmpRoot)
            .filter((n) => n.endsWith(".tmp"));
        expect(leftovers).toEqual([]);
    });

    // Windows has no POSIX mode bits: chmod only toggles read-only, so a
    // 0o600 file reads back as 0o666 before atomicTextWrite even runs.
    it.skipIf(process.platform === "win32")("preserves existing file permissions on overwrite", async () => {
        const target = path.join(tmpRoot, "secret.env");
        fs.writeFileSync(target, "x");
        fs.chmodSync(target, 0o600);
        await atomicTextWrite(target, "y");
        const mode = fs.statSync(target).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("preserves a symlink target (writes through to the real file)", async () => {
        const realFile = path.join(tmpRoot, "real.txt");
        const symlink = path.join(tmpRoot, "link.txt");
        fs.writeFileSync(realFile, "old");
        fs.symlinkSync(realFile, symlink);
        await atomicTextWrite(symlink, "new");
        // The symlink must still exist and point at realFile
        expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(realFile, "utf8")).toBe("new");
    });
});

describe("atomicJsonWrite", () => {
    it("serializes and writes JSON with a trailing newline", async () => {
        const target = path.join(tmpRoot, "data.json");
        await atomicJsonWrite(target, { a: 1, b: "x" });
        const raw = fs.readFileSync(target, "utf8");
        expect(raw.endsWith("\n")).toBe(true);
        expect(JSON.parse(raw)).toEqual({ a: 1, b: "x" });
    });

    it("uses 2-space indentation by default", async () => {
        const target = path.join(tmpRoot, "data.json");
        await atomicJsonWrite(target, { a: 1 });
        const raw = fs.readFileSync(target, "utf8");
        expect(raw).toContain('\n  "a": 1');
    });

    it("honors a custom indent", async () => {
        const target = path.join(tmpRoot, "data.json");
        await atomicJsonWrite(target, { a: 1 }, { indent: 4 });
        const raw = fs.readFileSync(target, "utf8");
        expect(raw).toContain('\n    "a": 1');
    });
});

describe("atomicReplace", () => {
    it("renames tmp to target", async () => {
        const tmp = path.join(tmpRoot, "x.tmp");
        const target = path.join(tmpRoot, "x.final");
        fs.writeFileSync(tmp, "content");
        await atomicReplace(tmp, target);
        expect(fs.existsSync(tmp)).toBe(false);
        expect(fs.readFileSync(target, "utf8")).toBe("content");
    });

    it("when target is a symlink, writes to the real path and keeps the symlink", async () => {
        const realFile = path.join(tmpRoot, "real");
        const symlink = path.join(tmpRoot, "link");
        const tmp = path.join(tmpRoot, "x.tmp");
        fs.writeFileSync(realFile, "old");
        fs.symlinkSync(realFile, symlink);
        fs.writeFileSync(tmp, "new");
        const resolved = await atomicReplace(tmp, symlink);
        expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(realFile, "utf8")).toBe("new");
        // .native like fs.promises.realpath: expands Windows 8.3 names (RUNNER~1).
        expect(resolved).toBe(fs.realpathSync.native(realFile));
    });
});

describe("baseUrlHost", () => {
    it("extracts the lowercase hostname from a full URL", () => {
        expect(baseUrlHost("https://API.OpenAI.com/v1")).toBe("api.openai.com");
    });

    it("strips trailing dots", () => {
        expect(baseUrlHost("https://api.openai.com./v1")).toBe("api.openai.com");
    });

    it("handles bare host (no scheme)", () => {
        expect(baseUrlHost("api.openai.com")).toBe("api.openai.com");
    });

    it("returns empty string for null/empty/whitespace input", () => {
        expect(baseUrlHost("")).toBe("");
        expect(baseUrlHost("   ")).toBe("");
        expect(baseUrlHost(null as unknown as string)).toBe("");
        expect(baseUrlHost(undefined as unknown as string)).toBe("");
    });
});

describe("baseUrlHostMatches", () => {
    it("matches exact domain", () => {
        expect(baseUrlHostMatches("https://openai.com/v1", "openai.com")).toBe(true);
    });

    it("matches legitimate subdomain", () => {
        expect(baseUrlHostMatches("https://api.openai.com/v1", "openai.com")).toBe(true);
    });

    it("rejects substring-path attacks (domain as path)", () => {
        expect(
            baseUrlHostMatches("https://evil.com/openai.com/v1", "openai.com"),
        ).toBe(false);
    });

    it("rejects lookalike suffix attacks (domain.evil)", () => {
        expect(baseUrlHostMatches("https://openai.com.evil/v1", "openai.com")).toBe(
            false,
        );
    });

    it("is case-insensitive", () => {
        expect(baseUrlHostMatches("https://API.OpenAI.COM", "openai.com")).toBe(
            true,
        );
    });

    it("returns false for empty inputs", () => {
        expect(baseUrlHostMatches("", "openai.com")).toBe(false);
        expect(baseUrlHostMatches("https://openai.com", "")).toBe(false);
    });
});

describe("normalizeProxyUrl", () => {
    it("rewrites socks:// to socks5:// (httpx compat)", () => {
        expect(normalizeProxyUrl("socks://127.0.0.1:1080")).toBe(
            "socks5://127.0.0.1:1080",
        );
    });

    it("uppercase scheme also normalized", () => {
        expect(normalizeProxyUrl("SOCKS://1.2.3.4:9")).toBe("socks5://1.2.3.4:9");
    });

    it("leaves socks5 untouched", () => {
        expect(normalizeProxyUrl("socks5://1.2.3.4:9")).toBe("socks5://1.2.3.4:9");
    });

    it("leaves http/https untouched", () => {
        expect(normalizeProxyUrl("http://proxy:8080")).toBe("http://proxy:8080");
        expect(normalizeProxyUrl("https://proxy:8080")).toBe("https://proxy:8080");
    });

    it("returns null for empty/null input", () => {
        expect(normalizeProxyUrl("")).toBe(null);
        expect(normalizeProxyUrl("   ")).toBe(null);
        expect(normalizeProxyUrl(null)).toBe(null);
        expect(normalizeProxyUrl(undefined)).toBe(null);
    });
});

describe("isTruthy", () => {
    it("treats 1/true/yes/on (any case) as truthy", () => {
        for (const v of ["1", "true", "yes", "on", "TRUE", "Yes", "ON"]) {
            expect(isTruthy(v)).toBe(true);
        }
    });

    it("treats 0/false/no/off/empty/other as falsy", () => {
        for (const v of ["0", "false", "no", "off", "", "  ", "xyz"]) {
            expect(isTruthy(v)).toBe(false);
        }
    });

    it("honors the default for null/undefined", () => {
        expect(isTruthy(undefined)).toBe(false);
        expect(isTruthy(null)).toBe(false);
        expect(isTruthy(undefined, true)).toBe(true);
    });

    it("passes through booleans", () => {
        expect(isTruthy(true)).toBe(true);
        expect(isTruthy(false)).toBe(false);
    });
});

describe("envInt", () => {
    const key = "ATLAS_TEST_INT_DO_NOT_SET";
    afterEach(() => {
        delete process.env[key];
    });

    it("returns the int value when set", () => {
        process.env[key] = "42";
        expect(envInt(key, 0)).toBe(42);
    });

    it("returns the default when unset", () => {
        expect(envInt(key, 7)).toBe(7);
    });

    it("returns the default on unparseable value", () => {
        process.env[key] = "not-a-number";
        expect(envInt(key, 7)).toBe(7);
    });

    it("returns the default on whitespace-only value", () => {
        process.env[key] = "   ";
        expect(envInt(key, 7)).toBe(7);
    });
});

describe("envBool", () => {
    const key = "ATLAS_TEST_BOOL_DO_NOT_SET";
    afterEach(() => {
        delete process.env[key];
    });

    it("returns true on truthy values", () => {
        process.env[key] = "true";
        expect(envBool(key, false)).toBe(true);
    });

    it("returns false on falsy values", () => {
        process.env[key] = "false";
        expect(envBool(key, true)).toBe(false);
    });

    it("uses the default when unset", () => {
        expect(envBool(key, true)).toBe(true);
        expect(envBool(key, false)).toBe(false);
    });
});

describe("safeJsonParse", () => {
    it("returns parsed object for valid JSON", () => {
        expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 });
    });

    it("returns the default for invalid JSON (no throw)", () => {
        expect(safeJsonParse("not json", null)).toBe(null);
        expect(safeJsonParse("{oops", { ok: false })).toEqual({ ok: false });
    });

    it("returns the default for non-string inputs", () => {
        expect(safeJsonParse(null as unknown as string, "d")).toBe("d");
        expect(safeJsonParse(undefined as unknown as string, "d")).toBe("d");
    });
});
