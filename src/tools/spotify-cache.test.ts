// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach } from "vitest";
import { _forTests, resetSpotifySession } from "./spotify.js";

describe("spotify last-played + auth caches", () => {
    beforeEach(() => {
        resetSpotifySession();
    });

    it("matchesLastPlayed returns the remembered track for the same query", () => {
        _forTests.rememberLastPlayed("Perfect", "spotify:track:0tgVp", "Perfect – Ed Sheeran");
        const hit = _forTests.matchesLastPlayed("Perfect");
        expect(hit?.uri).toBe("spotify:track:0tgVp");
    });

    it("matchesLastPlayed is case-insensitive and trim-tolerant", () => {
        _forTests.rememberLastPlayed("perfect", "spotify:track:X", "Perfect");
        expect(_forTests.matchesLastPlayed("  PERFECT  ")?.uri).toBe("spotify:track:X");
    });

    it("matchesLastPlayed misses for a different query", () => {
        _forTests.rememberLastPlayed("Perfect", "spotify:track:X", "Perfect");
        expect(_forTests.matchesLastPlayed("Closer")).toBeNull();
    });

    it("forgetLastPlayed clears the cache so transport controls don't replay a stale URI", () => {
        _forTests.rememberLastPlayed("Perfect", "spotify:track:X", "Perfect");
        _forTests.forgetLastPlayed();
        expect(_forTests.matchesLastPlayed("Perfect")).toBeNull();
    });

    it("resetSpotifySession clears both caches", () => {
        _forTests.setAuthOkAt(Date.now());
        _forTests.rememberLastPlayed("Perfect", "spotify:track:X", "Perfect");
        resetSpotifySession();
        expect(_forTests.getAuthOkAt()).toBe(0);
        expect(_forTests.getLastPlayed()).toBeNull();
    });

    it("invalidateAuthCache zeros the timestamp so the next play re-verifies", () => {
        _forTests.setAuthOkAt(Date.now());
        _forTests.invalidateAuthCache();
        expect(_forTests.getAuthOkAt()).toBe(0);
    });

    it("matchesLastPlayed expires entries older than 30 minutes", () => {
        _forTests.rememberLastPlayed("Perfect", "spotify:track:X", "Perfect");
        const cached = _forTests.getLastPlayed();
        expect(cached).not.toBeNull();
        // Rewrite the cache with an old timestamp.
        _forTests.rememberLastPlayed("Perfect", "spotify:track:X", "Perfect");
        const old = _forTests.getLastPlayed()!;
        (old as any).at = Date.now() - 31 * 60 * 1000;
        expect(_forTests.matchesLastPlayed("Perfect")).toBeNull();
    });
});
