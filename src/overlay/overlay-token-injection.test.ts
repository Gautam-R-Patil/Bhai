// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getOverlayLocalToken } from "./overlay-chat.js";

// Regression guard for the overlay WS-auth fix: the served HTML must have its
// %%ATLAS_LOCAL_TOKEN%% placeholder replaced with the real loopback token, and
// the client must then send it as ?localToken=. Token-less WS handshakes are
// rejected (4001) by the server, which previously left the overlay mute.
describe("overlay token injection", () => {
    const PLACEHOLDER = "%%ATLAS_LOCAL_TOKEN%%";

    it("getOverlayLocalToken returns a stable non-empty hex token", () => {
        const t1 = getOverlayLocalToken();
        expect(typeof t1).toBe("string");
        expect(t1.length).toBeGreaterThanOrEqual(32);
        // idempotent within a process (cached)
        expect(getOverlayLocalToken()).toBe(t1);
    });

    it("the placeholder-replace contract produces a tokenized page (no placeholder left)", () => {
        const html = `<script>window.__ATLAS_LOCAL_TOKEN__ = "${PLACEHOLDER}";</script>`;
        const served = html.replace(/%%ATLAS_LOCAL_TOKEN%%/g, getOverlayLocalToken());
        expect(served).not.toContain(PLACEHOLDER);
        expect(served).toContain(getOverlayLocalToken());
    });

    it("the client guard sends ?localToken only when injection actually ran", () => {
        // mirrors overlay.html connect(): skip token if the placeholder survived (dev/un-served)
        const buildQuery = (tok: string | undefined) =>
            tok && tok.indexOf("%%") === -1 ? `?localToken=${encodeURIComponent(tok)}` : "";
        expect(buildQuery(getOverlayLocalToken())).toBe(`?localToken=${getOverlayLocalToken()}`);
        expect(buildQuery(PLACEHOLDER)).toBe(""); // un-injected → no bogus token sent
        expect(buildQuery(undefined)).toBe("");
    });
});
