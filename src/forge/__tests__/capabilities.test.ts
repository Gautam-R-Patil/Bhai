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
