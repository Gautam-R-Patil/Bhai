// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import {
    asJSON,
    type Capabilities,
    isPathHardDenied,
    parseCapabilities,
    validateCapabilities,
} from "../capabilities.js";

describe("capabilities parse", () => {
    it("parseCapabilities accepts a well-formed declaration", () => {
        const caps = parseCapabilities({
            fs_read: ["~/Downloads/", "~/.atlas/store/dynamic/self/"],
            fs_write: [],
            net: ["api.openai.com"],
            exec: ["pdftotext"],
        });
        expect(caps.fs_read).toHaveLength(2);
        expect(caps.fs_write).toEqual([]);
        expect(caps.net).toEqual(["api.openai.com"]);
        expect(caps.exec).toEqual(["pdftotext"]);
    });

    it("parseCapabilities returns empty arrays when input is null", () => {
        const caps = parseCapabilities(null);
        expect(caps).toEqual({ fs_read: [], fs_write: [], net: [], exec: [] });
    });

    it("parseCapabilities returns empty arrays when input is undefined", () => {
        const caps = parseCapabilities(undefined);
        expect(caps).toEqual({ fs_read: [], fs_write: [], net: [], exec: [] });
    });

    it("parseCapabilities filters non-string entries from arrays", () => {
        const caps = parseCapabilities({
            fs_read: ["~/ok/", 42, null, "/var/log"],
            fs_write: ["/tmp", { malicious: true }],
            net: [],
            exec: [],
        });
        expect(caps.fs_read).toEqual(["~/ok/", "/var/log"]);
        expect(caps.fs_write).toEqual(["/tmp"]);
    });

    it("asJSON round-trips through JSON.parse", () => {
        const caps: Capabilities = {
            fs_read: ["~/Downloads/"],
            fs_write: [],
            net: ["api.example.com"],
            exec: [],
        };
        expect(JSON.parse(asJSON(caps))).toEqual(caps);
    });
});

describe("capabilities validate", () => {
    it("validateCapabilities rejects overly-broad fs_read paths", () => {
        const result = validateCapabilities({
            fs_read: ["/"],
            fs_write: [],
            net: [],
            exec: [],
        });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/overly broad|root/i);
    });

    it("validateCapabilities rejects overly-broad fs_write paths", () => {
        const result = validateCapabilities({
            fs_read: [],
            fs_write: ["~"],
            net: [],
            exec: [],
        });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/overly broad/i);
    });

    it("validateCapabilities rejects banned commands in exec", () => {
        const result = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: [],
            exec: ["rm"],
        });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/banned.*command|rm/i);
    });

    it("validateCapabilities rejects sudo even with args", () => {
        const r = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: [],
            exec: ["sudo apt-get install foo"],
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/sudo/);
    });

    it("validateCapabilities rejects wildcard net host", () => {
        const r = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: ["*"],
            exec: [],
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/too broad|hostname/i);
    });

    it("validateCapabilities rejects localhost / loopback net entries", () => {
        const r = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: ["localhost", "127.0.0.1", "0.0.0.0"],
            exec: [],
        });
        expect(r.ok).toBe(false);
        expect(r.errors.length).toBe(3);
    });

    it("validateCapabilities accepts a minimal declaration", () => {
        const r = validateCapabilities({
            fs_read: ["~/Downloads/"],
            fs_write: [],
            net: [],
            exec: [],
        });
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
    });

    it("validateCapabilities catches whitespace-prefixed banned commands", () => {
        const r = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: [],
            exec: [" rm"],
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/banned.*command/i);
    });

    it("validateCapabilities catches absolute-path banned commands", () => {
        const r = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: [],
            exec: ["/usr/bin/rm -rf /"],
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/banned.*command/i);
    });

    it("validateCapabilities rejects IPv6 loopback hosts", () => {
        const r = validateCapabilities({
            fs_read: [],
            fs_write: [],
            net: ["::1", "::"],
            exec: [],
        });
        expect(r.ok).toBe(false);
        expect(r.errors.length).toBe(2);
    });
});

describe("isPathHardDenied", () => {
    it("catches /etc/passwd (lowercase)", () => {
        expect(isPathHardDenied("/etc/passwd")).toBe(true);
    });

    it("catches /etc/shadow", () => {
        expect(isPathHardDenied("/etc/shadow")).toBe(true);
    });

    it("catches /etc/sudoers", () => {
        expect(isPathHardDenied("/etc/sudoers")).toBe(true);
    });

    it("catches ~/.ssh paths", () => {
        expect(isPathHardDenied("/Users/x/.ssh/id_rsa")).toBe(true);
    });

    it("catches ~/.aws and ~/.gnupg paths", () => {
        expect(isPathHardDenied("/Users/x/.aws/credentials")).toBe(true);
        expect(isPathHardDenied("/Users/x/.gnupg/private-keys-v1.d/key.key")).toBe(true);
    });

    it("catches encrypted ATLAS source paths", () => {
        expect(isPathHardDenied("/Users/x/Desktop/ATLAS/src/agent.ts")).toBe(true);
        expect(isPathHardDenied("/Users/x/Desktop/ATLAS/native/index.js")).toBe(true);
        expect(isPathHardDenied("/Users/x/Desktop/ATLAS/prompts/identity.md")).toBe(true);
        expect(isPathHardDenied("/Users/x/Desktop/ATLAS/convex/http.ts")).toBe(true);
    });

    it("does NOT flag ~/.atlas/store/dynamic (the legit tool home)", () => {
        expect(isPathHardDenied("/Users/x/.atlas/store/dynamic/foo/handler.js")).toBe(false);
    });

    it("does NOT flag arbitrary user paths", () => {
        expect(isPathHardDenied("/Users/x/Downloads/file.pdf")).toBe(false);
        expect(isPathHardDenied("/tmp/scratch.txt")).toBe(false);
    });

    it("catches uppercase /etc/PASSWD on darwin/win32 (case-insensitive FS bypass fix)", () => {
        if (process.platform === "linux") {
            expect(isPathHardDenied("/etc/PASSWD")).toBe(false);
            return;
        }
        expect(isPathHardDenied("/etc/PASSWD")).toBe(true);
        expect(isPathHardDenied("/Etc/Passwd")).toBe(true);
        expect(isPathHardDenied("/USERS/x/.SSH/id_rsa")).toBe(true);
    });

    it("catches mixed-case encrypted source paths on darwin/win32", () => {
        if (process.platform === "linux") return;
        expect(isPathHardDenied("/Users/x/Desktop/ATLAS/SRC/agent.ts")).toBe(true);
        expect(isPathHardDenied("/Users/x/Desktop/ATLAS/Convex/http.ts")).toBe(true);
    });
});
