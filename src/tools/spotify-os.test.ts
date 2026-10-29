// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { checkedSpotifyUri } from "./spotify-os.js";

describe("checkedSpotifyUri", () => {
    // Windows hands the URI to `cmd.exe /c start`, so shell metacharacters must never get through.
    it.each([
        "spotify:track:abc&calc",
        "spotify:track:abc|calc",
        'spotify:track:abc" & calc',
        "spotify:track:abc%20x",
        "https://open.spotify.com/track/a&b",
        "https://open.spotify.com.evil.com/track/abc",
        "file:///etc/passwd",
    ])("rejects %s", (uri) => {
        expect(() => checkedSpotifyUri(uri)).toThrow(/Invalid Spotify URI/);
    });

    it.each([
        ["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:track:4uLU6hMCjMI75M1A2tKUQC"],
        ["https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"],
        // A pasted share link: the tracking query is dropped, not rejected.
        ["https://open.spotify.com/playlist/x?si=a&pi=b", "https://open.spotify.com/playlist/x"],
        ["https://open.spotify.com/track/abc?si=x&calc", "https://open.spotify.com/track/abc"],
    ])("accepts %s", (uri, expected) => {
        expect(checkedSpotifyUri(uri)).toBe(expected);
    });
});
