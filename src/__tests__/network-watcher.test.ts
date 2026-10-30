// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import type os from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("../location/index.js", () => ({ refreshLocation: vi.fn() }));
const { networkSignature } = await import("../location/network-watcher.js");

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal }) as os.NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: "IPv6", internal: false }) as os.NetworkInterfaceInfo;

describe("networkSignature", () => {
    it("is the sorted external IPv4 addresses; loopback and rotating IPv6 don't count", () => {
        const a = { lo0: [v4("127.0.0.1", true)], en0: [v6("fe80::1"), v4("192.168.1.9")], utun3: [v4("10.8.0.2")] };
        const b = { utun3: [v4("10.8.0.2")], en0: [v6("fe80::77"), v4("192.168.1.9")], lo0: [v4("127.0.0.1", true)] };
        expect(networkSignature(a)).toBe("10.8.0.2,192.168.1.9");
        expect(networkSignature(b)).toBe(networkSignature(a));
        expect(networkSignature({ en0: [v4("172.20.10.3")] })).not.toBe(networkSignature(a));
        expect(networkSignature({ lo0: [v4("127.0.0.1", true)] })).toBe("");
    });
});
