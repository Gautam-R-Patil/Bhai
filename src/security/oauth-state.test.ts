// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { startOAuthCallback } from "../marketing/credential-setup/oauth-callback.js";
import { newOAuthState, oauthStateMatches } from "./oauth-state.js";

describe("Google OAuth callback state", () => {
    it("accepts only the state this sign-in sent", () => {
        expect(oauthStateMatches("abc123", "abc123")).toBe(true);
        expect(oauthStateMatches(null, "abc123")).toBe(false); // a redirect forged without it
        expect(oauthStateMatches("", "abc123")).toBe(false);
        expect(oauthStateMatches("abc124", "abc123")).toBe(false);
        expect(oauthStateMatches("abc1234", "abc123")).toBe(false); // length differs: no throw
    });

    it("makes a fresh unguessable state each time", () => {
        const a = newOAuthState();
        expect(a).toMatch(/^[\w-]{32}$/);
        expect(newOAuthState()).not.toBe(a);
    });
});

describe("startOAuthCallback", () => {
    it("ignores a code or error without this flow's state, then takes the real callback", async () => {
        const port = 18_000 + Math.floor(Math.random() * 1000);
        const state = newOAuthState();
        const result = startOAuthCallback(port, state, 5000);
        await new Promise((r) => setTimeout(r, 100));
        const base = `http://127.0.0.1:${port}/`;
        expect((await fetch(`${base}?error=access_denied`)).status).toBe(400); // can't abort the sign-in
        expect((await fetch(`${base}?code=ATTACKER&state=wrong`)).status).toBe(400); // can't swap accounts
        expect((await fetch(`${base}?code=REAL&state=${state}`)).status).toBe(200);
        expect(await result).toEqual({ code: "REAL" });
    });
});
