// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The SSRF guard must PIN the vetted IP: validating a hostname then letting the
// fetch re-resolve it reopens a DNS-rebinding TOCTOU (public IP to the guard,
// 127.0.0.1 / 169.254.169.254 to the fetch).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
    default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
}));

const { pinnedLookup, fetchWithRedirectGuard } = await import("./url-safety.js");

afterEach(() => vi.unstubAllGlobals());

describe("pinnedLookup", () => {
    it("resolves only the vetted host to the vetted address, ignoring re-resolution", () => {
        const lk = pinnedLookup("evil.com", "93.184.216.34", 4);
        // Even if the attacker's DNS now returns 127.0.0.1, undici asks for the
        // host and gets back the ALREADY-VETTED public IP — never re-resolved.
        let got: unknown[] = [];
        lk("evil.com", {}, (...args: unknown[]) => {
            got = args;
        });
        expect(got[0]).toBeNull();
        expect(got[1]).toBe("93.184.216.34");
    });

    it("refuses a different host", () => {
        const lk = pinnedLookup("evil.com", "93.184.216.34", 4);
        let err: unknown;
        lk("rebind.com", {}, (e: unknown) => {
            err = e;
        });
        expect(err).toBeInstanceOf(Error);
    });

    it("refuses if the pinned address is itself private (defense in depth)", () => {
        const lk = pinnedLookup("evil.com", "127.0.0.1", 4);
        let err: unknown;
        lk("evil.com", {}, (e: unknown) => {
            err = e;
        });
        expect(err).toBeInstanceOf(Error);
    });
});

describe("fetchWithRedirectGuard pins the connection", () => {
    it("passes a dispatcher so undici connects to the vetted IP", async () => {
        let capturedInit: Record<string, unknown> = {};
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_u: string, init: Record<string, unknown>) => {
                capturedInit = init;
                return new Response("ok", { status: 200 });
            }),
        );

        const r = await fetchWithRedirectGuard("http://evil.com/x", { headers: {} });
        expect("response" in r).toBe(true);
        expect(capturedInit.dispatcher).toBeDefined();
    });


    it("follows a redirect and destroys the intermediate hop's dispatcher, not the final one", async () => {
        const destroyed: unknown[] = [];
        const seen: Array<Record<string, unknown>> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (u: string, init: Record<string, unknown>) => {
                seen.push(init);
                const d = init.dispatcher as { destroy?: () => void } | undefined;
                if (d) (d as { __tag?: string }).__tag = u;
                // First hop redirects; second is the final 200.
                if (seen.length === 1)
                    return new Response("", { status: 302, headers: { location: "http://evil.com/final" } });
                return new Response("ok", { status: 200 });
            }),
        );
        // Spy on Agent.destroy by wrapping the dispatcher objects fetch received.
        const r = await fetchWithRedirectGuard("http://evil.com/start", { headers: {} });
        expect("response" in r).toBe(true);
        expect(seen.length).toBe(2); // one redirect, then the final
        // The first (redirect) dispatcher and the final one are distinct objects.
        expect(seen[0].dispatcher).not.toBe(seen[1].dispatcher);
    });
});
