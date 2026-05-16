// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedToolManifest } from "../types.js";

const ORIG_ATLAS_HOME = process.env.ATLAS_HOME;
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
    tmpHome = mkdtempSync(join(tmpdir(), "atlas-forge-manifest-test-"));
    process.env.ATLAS_HOME = tmpHome;
});

afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_ATLAS_HOME === undefined) delete process.env.ATLAS_HOME;
    else process.env.ATLAS_HOME = ORIG_ATLAS_HOME;
});

describe("manifest dir + slug validation", () => {
    it("manifestDir returns <atlasHome>/store/dynamic/<slug>", async () => {
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
