// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedToolManifest } from "../types.js";

const ORIG_BHAI_HOME = process.env.BHAI_HOME;
let tmpHome: string;

const exampleManifest: PersistedToolManifest = {
    slug: "extract_invoice",
    description: "Extract invoice fields from a PDF",
    capabilities: { fs_read: ["~/Downloads/"], fs_write: [], net: [], exec: [] },
    parametersSchema: {
        type: "object",
        properties: { pdfPath: { type: "string" } },
        required: ["pdfPath"],
    },
    version: "0.1.0",
    approvedAt: 1700000000000,
    userQuote: "yes go ahead and approve this tool",
    handlerHash: "deadbeefcafe1234",
};

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "bhai-forge-manifest-test-"));
    process.env.BHAI_HOME = tmpHome;
});

afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_BHAI_HOME === undefined) delete process.env.BHAI_HOME;
    else process.env.BHAI_HOME = ORIG_BHAI_HOME;
});

describe("manifest dir + slug validation", () => {
    it("manifestDir returns <bhaiHome>/store/dynamic/<slug>", async () => {
        const { manifestDir, getDynamicStoreDir } = await import("../manifest.js");
        expect(getDynamicStoreDir()).toBe(join(tmpHome, "store", "dynamic"));
        expect(manifestDir("extract_invoice")).toBe(
            join(tmpHome, "store", "dynamic", "extract_invoice"),
        );
    });

    it("manifestDir rejects slug with path traversal '..'", async () => {
        const { manifestDir } = await import("../manifest.js");
        expect(() => manifestDir("foo/../etc")).toThrow(/invalid slug/i);
        expect(() => manifestDir("..")).toThrow(/invalid slug/i);
        expect(() => manifestDir("../etc")).toThrow(/invalid slug/i);
    });

    it("manifestDir rejects slug with forward slash", async () => {
        const { manifestDir } = await import("../manifest.js");
        expect(() => manifestDir("foo/bar")).toThrow(/invalid slug/i);
    });

    it("manifestDir rejects slug with backslash", async () => {
        const { manifestDir } = await import("../manifest.js");
        expect(() => manifestDir("foo\\bar")).toThrow(/invalid slug/i);
    });

    it("manifestDir rejects empty slug", async () => {
        const { manifestDir } = await import("../manifest.js");
        expect(() => manifestDir("")).toThrow(/invalid slug/i);
    });

    it("manifestDir rejects slug starting with digit or underscore", async () => {
        const { manifestDir } = await import("../manifest.js");
        expect(() => manifestDir("1foo")).toThrow(/invalid slug/i);
        expect(() => manifestDir("_foo")).toThrow(/invalid slug/i);
    });
});

describe("manifest write + read round-trip", () => {
    it("writeManifest persists, readManifest reads back the same value", async () => {
        const { writeManifest, readManifest } = await import("../manifest.js");
        await writeManifest("extract_invoice", exampleManifest);

        const path = join(tmpHome, "store", "dynamic", "extract_invoice", "manifest.json");
        expect(existsSync(path)).toBe(true);

        const got = readManifest("extract_invoice");
        expect(got).toEqual(exampleManifest);
    });

    it("readManifest returns null when the manifest doesn't exist", async () => {
        const { readManifest } = await import("../manifest.js");
        expect(readManifest("nope_not_here")).toBeNull();
    });

    it("readManifest returns null when the manifest is malformed JSON", async () => {
        const { readManifest, manifestDir } = await import("../manifest.js");
        const { mkdirSync } = await import("node:fs");
        const dir = manifestDir("garbage_slug");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "manifest.json"), "{ not json", "utf-8");
        expect(readManifest("garbage_slug")).toBeNull();
    });

    it("readManifest returns null when the manifest fails validateManifest", async () => {
        const { readManifest, manifestDir } = await import("../manifest.js");
        const { mkdirSync } = await import("node:fs");
        const dir = manifestDir("broken_slug");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ slug: "broken_slug" }), "utf-8");
        expect(readManifest("broken_slug")).toBeNull();
    });

    it("readManifest returns null when slug in file doesn't match the requested slug", async () => {
        const { readManifest, writeManifest } = await import("../manifest.js");
        await writeManifest("extract_invoice", exampleManifest);

        const path = join(tmpHome, "store", "dynamic", "extract_invoice", "manifest.json");
        writeFileSync(
            path,
            JSON.stringify({ ...exampleManifest, slug: "other_slug" }),
            "utf-8",
        );

        expect(readManifest("extract_invoice")).toBeNull();
    });

    it("writeManifest rejects oversized manifest (>64KB)", async () => {
        const { writeManifest } = await import("../manifest.js");
        // Build a manifest with a userQuote large enough to push the indented
        // serialization over 64KB. The serialized form has prefixes + escaping
        // that inflate the byte count; 70K characters of plain ASCII suffices.
        const huge: PersistedToolManifest = {
            ...exampleManifest,
            userQuote: "x".repeat(70_000),
        };
        await expect(writeManifest("extract_invoice", huge)).rejects.toThrow(/too large/);
    });

    it("writeManifest rejects an invalid manifest without writing a placeholder", async () => {
        const { writeManifest, manifestDir } = await import("../manifest.js");
        const { existsSync: _existsSync } = await import("node:fs");
        const invalid = { ...exampleManifest, handlerHash: "bad" };
        await expect(writeManifest("extract_invoice", invalid)).rejects.toThrow(/invalid manifest|handlerHash/);
        // Confirm: the slug directory was NOT created, NOR was a placeholder
        // manifest.json left on disk.
        const dir = manifestDir("extract_invoice");
        expect(_existsSync(dir)).toBe(false);
    });

    it("writeManifest is atomic (no partial JSON visible mid-write)", async () => {
        const { writeManifest, readManifest } = await import("../manifest.js");
        // First write the canonical manifest so the file exists.
        await writeManifest("extract_invoice", exampleManifest);

        // Now fire many concurrent writes with varied (still valid) approvedAt values.
        // Every interleaved read must see EITHER a fully-valid earlier manifest OR
        // a fully-valid later one — never null (which would mean a partial JSON
        // was visible mid-write and failed validateManifest).
        const writes = Array.from({ length: 10 }, (_, i) =>
            writeManifest("extract_invoice", { ...exampleManifest, approvedAt: 1700000000000 + i }),
        );
        const reads = Array.from({ length: 50 }, () => readManifest("extract_invoice"));

        const results = await Promise.all([...writes, ...reads.map((r) => Promise.resolve(r))]);
        const reads_only = results.slice(10) as Array<PersistedToolManifest | null>;
        for (const r of reads_only) {
            // Every read must be non-null AND have a valid handlerHash.
            expect(r).not.toBeNull();
            if (r) expect(r.handlerHash).toBe("deadbeefcafe1234");
        }
    });
});

describe("validateManifest", () => {
    it("accepts a well-formed manifest", async () => {
        const { validateManifest } = await import("../manifest.js");
        const r = validateManifest(exampleManifest);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.manifest.slug).toBe("extract_invoice");
    });

    it("rejects missing slug", async () => {
        const { validateManifest } = await import("../manifest.js");
        const { slug: _unused, ...rest } = exampleManifest;
        const r = validateManifest(rest);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/slug/);
    });

    it("rejects non-string version", async () => {
        const { validateManifest } = await import("../manifest.js");
        const r = validateManifest({ ...exampleManifest, version: 1 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/version/);
    });

    it("rejects non-object input entirely", async () => {
        const { validateManifest } = await import("../manifest.js");
        expect(validateManifest(null).ok).toBe(false);
        expect(validateManifest("string").ok).toBe(false);
        expect(validateManifest(42).ok).toBe(false);
    });

    it("rejects handlerHash of wrong length", async () => {
        const { validateManifest } = await import("../manifest.js");
        const r = validateManifest({ ...exampleManifest, handlerHash: "short" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/handlerHash/);
    });

    it("rejects negative or non-finite approvedAt", async () => {
        const { validateManifest } = await import("../manifest.js");
        expect(validateManifest({ ...exampleManifest, approvedAt: -1 }).ok).toBe(false);
        expect(validateManifest({ ...exampleManifest, approvedAt: Number.NaN }).ok).toBe(false);
        expect(validateManifest({ ...exampleManifest, approvedAt: Number.POSITIVE_INFINITY }).ok).toBe(
            false,
        );
    });
});
