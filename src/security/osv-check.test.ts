// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPackageForMalware } from "./osv-check.js";

function mockFetchVulns(vulns: Array<{ id: string }>): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => ({
        ok: true,
        json: async () => ({ vulns }),
    }));
    vi.stubGlobal("fetch", fn);
    return fn;
}

function lastBody(fn: ReturnType<typeof vi.fn>): { package: { name: string; ecosystem: string }; version?: string } {
    const call = fn.mock.calls[fn.mock.calls.length - 1];
    return JSON.parse((call[1] as { body: string }).body);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ATLAS_NO_OSV_CHECK;
});

describe("ecosystem inference", () => {
    it("npx → npm, queries OSV", async () => {
        const fn = mockFetchVulns([]);
        const r = await checkPackageForMalware("npx", ["some-pkg"]);
        expect(r.blocked).toBe(false);
        expect(r.pkg?.ecosystem).toBe("npm");
        expect(fn).toHaveBeenCalledOnce();
    });

    it("/usr/bin/npx → npm via basename", async () => {
        const fn = mockFetchVulns([]);
        const r = await checkPackageForMalware("/usr/bin/npx", ["some-pkg"]);
        expect(r.pkg?.ecosystem).toBe("npm");
        expect(fn).toHaveBeenCalledOnce();
    });

    it("uvx → PyPI", async () => {
        const fn = mockFetchVulns([]);
        const r = await checkPackageForMalware("uvx", ["some-pkg"]);
        expect(r.pkg?.ecosystem).toBe("PyPI");
        expect(fn).toHaveBeenCalledOnce();
    });

    it("pipx → PyPI", async () => {
        const fn = mockFetchVulns([]);
        const r = await checkPackageForMalware("pipx", ["some-pkg"]);
        expect(r.pkg?.ecosystem).toBe("PyPI");
        expect(fn).toHaveBeenCalledOnce();
    });

    it.each(["node", "docker", "python", "bunx", "npm", "/opt/scripts/run.sh"])(
        "%s → allow without fetch",
        async (cmd) => {
            const fn = mockFetchVulns([]);
            const r = await checkPackageForMalware(cmd, ["some-pkg"]);
            expect(r.blocked).toBe(false);
            expect(fn).not.toHaveBeenCalled();
        },
    );
});

describe("npm package parsing", () => {
    it("scoped name + version", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["@scope/pkg@1.2.3"]);
        expect(lastBody(fn)).toEqual({ package: { name: "@scope/pkg", ecosystem: "npm" }, version: "1.2.3" });
    });

    it("unscoped name + version", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["pkg@2.0.0"]);
        expect(lastBody(fn)).toEqual({ package: { name: "pkg", ecosystem: "npm" }, version: "2.0.0" });
    });

    it("skips -y flag", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["-y", "pkg"]);
        expect(lastBody(fn).package.name).toBe("pkg");
    });

    it("picks the -p package value over a later runner token", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["-p", "real-pkg", "runner"]);
        expect(lastBody(fn).package.name).toBe("real-pkg");
    });

    it("omits tag version (latest) from the body", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["pkg@latest"]);
        expect(lastBody(fn)).toEqual({ package: { name: "pkg", ecosystem: "npm" } });
    });

    it("bare name → no version", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["pkg"]);
        expect(lastBody(fn)).toEqual({ package: { name: "pkg", ecosystem: "npm" } });
    });
});

describe("PyPI package parsing", () => {
    it("extras + ==version", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("uvx", ["pkg[extra1,extra2]==1.0"]);
        expect(lastBody(fn)).toEqual({ package: { name: "pkg", ecosystem: "PyPI" }, version: "1.0" });
    });

    it("range specifier → version omitted", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("uvx", ["pkg>=1"]);
        expect(lastBody(fn)).toEqual({ package: { name: "pkg", ecosystem: "PyPI" } });
    });

    it("--from value is the package", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("uvx", ["--from", "tool", "cmd"]);
        expect(lastBody(fn).package.name).toBe("tool");
    });

    it("PEP503 name normalization", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("uvx", ["Foo_Bar"]);
        expect(lastBody(fn).package.name).toBe("foo-bar");
    });
});

describe("MAL- advisory filtering", () => {
    it("blocks on MAL-, filters CVE/GHSA", async () => {
        mockFetchVulns([{ id: "MAL-2024-1" }, { id: "GHSA-xxxx" }, { id: "CVE-2024-9" }]);
        const r = await checkPackageForMalware("npx", ["evil-pkg"]);
        expect(r.blocked).toBe(true);
        expect(r.advisoryIds).toEqual(["MAL-2024-1"]);
        expect(r.reason).toContain("MAL-2024-1");
    });

    it("caps advisory ids at 3", async () => {
        mockFetchVulns([{ id: "MAL-1" }, { id: "MAL-2" }, { id: "MAL-3" }, { id: "MAL-4" }]);
        const r = await checkPackageForMalware("npx", ["evil-pkg"]);
        expect(r.blocked).toBe(true);
        expect(r.advisoryIds).toHaveLength(3);
    });

    it("no vulns → not blocked", async () => {
        mockFetchVulns([]);
        const r = await checkPackageForMalware("npx", ["clean-pkg"]);
        expect(r.blocked).toBe(false);
    });

    it("only CVE/GHSA → not blocked", async () => {
        mockFetchVulns([{ id: "CVE-2024-1" }, { id: "GHSA-abcd" }]);
        const r = await checkPackageForMalware("npx", ["pkg"]);
        expect(r.blocked).toBe(false);
    });

    it("case-insensitive mal- prefix", async () => {
        mockFetchVulns([{ id: "mal-lower-1" }]);
        const r = await checkPackageForMalware("npx", ["pkg"]);
        expect(r.blocked).toBe(true);
        expect(r.advisoryIds).toEqual(["mal-lower-1"]);
    });
});

describe("fail-open behavior", () => {
    it("network throw → allow, no throw", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("ECONNREFUSED");
        }));
        const r = await checkPackageForMalware("npx", ["pkg"]);
        expect(r.blocked).toBe(false);
        expect(r.reason).toBe("osv-unreachable");
    });

    it("non-2xx → allow", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
        const r = await checkPackageForMalware("npx", ["pkg"]);
        expect(r.blocked).toBe(false);
        expect(r.reason).toBe("osv-unreachable");
    });

    it("invalid JSON → allow", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: true,
            json: async () => {
                throw new Error("Unexpected token");
            },
        })));
        const r = await checkPackageForMalware("npx", ["pkg"]);
        expect(r.blocked).toBe(false);
    });

    it("AbortError (timeout) → allow", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
        }));
        const r = await checkPackageForMalware("npx", ["pkg"]);
        expect(r.blocked).toBe(false);
    });
});

describe("kill-switch", () => {
    beforeEach(() => {
        process.env.ATLAS_NO_OSV_CHECK = "true";
    });

    it("disabled → allow, no fetch", async () => {
        const fn = mockFetchVulns([{ id: "MAL-2024-1" }]);
        const r = await checkPackageForMalware("npx", ["evil-pkg"]);
        expect(r.blocked).toBe(false);
        expect(r.advisoryIds).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe("request shape", () => {
    it("POSTs to api.osv.dev with JSON content-type", async () => {
        const fn = mockFetchVulns([]);
        await checkPackageForMalware("npx", ["pkg@1.0.0"]);
        const call = fn.mock.calls[0];
        expect(call[0]).toBe("https://api.osv.dev/v1/query");
        expect((call[1] as { method: string }).method).toBe("POST");
        expect((call[1] as { headers: Record<string, string> }).headers["content-type"]).toBe("application/json");
    });
});
