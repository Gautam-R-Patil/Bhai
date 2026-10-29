// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { isBrowserPageLoad } from "../security/loopback.js";
import { getOverlayLocalToken, overlayPageToken } from "./overlay-chat.js";

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

describe("the owner token isn't handed to whoever loads a page", () => {
    it("the overlay page carries the token only for the desktop app's own request", () => {
        const tok = getOverlayLocalToken();
        expect(overlayPageToken(tok)).toBe(tok); // desktop/main.js sends X-Bhai-Overlay
        expect(overlayPageToken(undefined)).toBe(""); // a browser tab, curl, another account
        expect(overlayPageToken("guess")).toBe("");
        expect(overlayPageToken([tok, tok])).toBe("");
    });

    it("/discover refuses a browser page load but not the extension's or a CLI's fetch", () => {
        // The agent's browser sent to http://127.0.0.1:18800/discover by a web page.
        expect(isBrowserPageLoad({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).toBe(true);
        expect(isBrowserPageLoad({ "sec-fetch-dest": "iframe" })).toBe(true);
        // The extension's service-worker fetch, and curl / a local tool (no fetch metadata).
        expect(isBrowserPageLoad({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).toBe(false);
        expect(isBrowserPageLoad({})).toBe(false);
    });
});
