// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { startOAuthCallback } from "../marketing/credential-setup/oauth-callback.js";

describe("startOAuthCallback", () => {
    it("escapes the reflected ?error= value", async () => {
        const port = 20000 + Math.floor(Math.random() * 20000);
        const pending = startOAuthCallback(port, "st4te", 5000);
        await new Promise((r) => setTimeout(r, 50));
        const res = await fetch(`http://127.0.0.1:${port}/?state=st4te&error=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
        const html = await res.text();
        expect(html).not.toContain("<img");
        expect(html).toContain("img src=x onerror=alert(1)"); // shown as text, entity-escaped
        expect(await pending).toEqual({ error: "OAuth denied: <img src=x onerror=alert(1)>" });
    });
});
