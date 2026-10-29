// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { isLoopbackHost, isWebOrigin } from "./loopback.js";

describe("loopback guard", () => {
    it("accepts only the loopback host on the server's own port", () => {
        expect(isLoopbackHost("127.0.0.1:18800", 18800)).toBe(true);
        expect(isLoopbackHost("localhost:18800", 18800)).toBe(true);
        expect(isLoopbackHost("127.0.0.1:18792", 18800)).toBe(false);
        expect(isLoopbackHost("evil.example:18800", 18800)).toBe(false); // DNS-rebound page
        expect(isLoopbackHost(undefined, 18800)).toBe(false);
    });
    it("tells web pages from the extension and local tools", () => {
        expect(isWebOrigin("https://evil.example")).toBe(true);
        expect(isWebOrigin("http://127.0.0.1:18792")).toBe(true);
        expect(isWebOrigin("chrome-extension://abcdef")).toBe(false);
        expect(isWebOrigin(undefined)).toBe(false);
    });
});
