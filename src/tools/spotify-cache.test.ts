// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { beforeEach, describe, expect, it } from "vitest";
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

describe("spotify liked-songs intent detection", () => {
    it("matches 'play my liked songs' phrasings", () => {
        expect(_forTests.isLikedSongsQuery("liked songs")).toBe(true);
        expect(_forTests.isLikedSongsQuery("my liked songs")).toBe(true);
        expect(_forTests.isLikedSongsQuery("liked playlist")).toBe(true);
        expect(_forTests.isLikedSongsQuery("liked music")).toBe(true);
        expect(_forTests.isLikedSongsQuery("my favourites")).toBe(true);
        expect(_forTests.isLikedSongsQuery("favorites")).toBe(true);
        expect(_forTests.isLikedSongsQuery("saved songs")).toBe(true);
        expect(_forTests.isLikedSongsQuery("saved tracks")).toBe(true);
    });
    it("does not match unrelated queries", () => {
        expect(_forTests.isLikedSongsQuery("perfect")).toBe(false);
        expect(_forTests.isLikedSongsQuery("my chill playlist")).toBe(false);
        expect(_forTests.isLikedSongsQuery("songs I like by Ed Sheeran")).toBe(false);
    });
    it("exposes the spotify:collection:tracks URI", () => {
        expect(_forTests.likedSongsUri()).toBe("spotify:collection:tracks");
    });
});

describe("spotify uri type classifier", () => {
    it("classifies every context type correctly", () => {
        expect(_forTests.uriType("spotify:track:abc")).toBe("track");
        expect(_forTests.uriType("spotify:album:abc")).toBe("album");
        expect(_forTests.uriType("spotify:playlist:abc")).toBe("playlist");
        expect(_forTests.uriType("spotify:artist:abc")).toBe("artist");
        expect(_forTests.uriType("spotify:collection:tracks")).toBe("collection");
        expect(_forTests.uriType("spotify:show:abc")).toBe("show");
        expect(_forTests.uriType("spotify:episode:abc")).toBe("episode");
        expect(_forTests.uriType("https://open.spotify.com/track/abc")).toBe("unknown");
        expect(_forTests.uriType("garbage")).toBe("unknown");
        expect(_forTests.uriType("")).toBe("unknown");
        // spogo occasionally emits spotify:user:<id>:playlist:<id>; only the
        // first segment is classified and that's fine — we don't use the "user"
        // type for anything, so it's intentionally "unknown".
        expect(_forTests.uriType("spotify:user:alice:playlist:abc")).toBe("unknown");
    });
});

describe("spotify liked-songs regex anchoring", () => {
    it("does not match queries with trailing qualifiers (artist/year/context)", () => {
        expect(_forTests.isLikedSongsQuery("liked songs by Ed Sheeran")).toBe(false);
        expect(_forTests.isLikedSongsQuery("my favorites of 2024")).toBe(false);
        expect(_forTests.isLikedSongsQuery("liked playlist chill vibes")).toBe(false);
        expect(_forTests.isLikedSongsQuery("saved tracks from 2020")).toBe(false);
    });
    it("matches natural phrasings including 'play my ...' prefix", () => {
        expect(_forTests.isLikedSongsQuery("play my liked songs")).toBe(true);
        expect(_forTests.isLikedSongsQuery("play liked music")).toBe(true);
        expect(_forTests.isLikedSongsQuery("play my favourites")).toBe(true);
    });
});

describe("spotify context-type helper", () => {
    it("treats playlist/album/artist/collection as contexts", () => {
        expect(_forTests.isContextType("playlist")).toBe(true);
        expect(_forTests.isContextType("album")).toBe(true);
        expect(_forTests.isContextType("artist")).toBe(true);
        expect(_forTests.isContextType("collection")).toBe(true);
    });
    it("treats track/show/episode/unknown as non-context", () => {
        expect(_forTests.isContextType("track")).toBe(false);
        expect(_forTests.isContextType("show")).toBe(false);
        expect(_forTests.isContextType("episode")).toBe(false);
        expect(_forTests.isContextType("unknown")).toBe(false);
    });
});

describe("spotify unsupported-operation detection", () => {
    it("recognises spogo's connect-engine unsupported messages", () => {
        expect(
            _forTests.isSpogoUnsupportedError(
                "unsupported operation: library tracks not supported in connect engine yet",
            ),
        ).toBe(true);
        expect(
            _forTests.isSpogoUnsupportedError("unsupported operation: playlists not supported in connect engine yet"),
        ).toBe(true);
        expect(
            _forTests.isSpogoUnsupportedError(
                "unsupported operation: playlist tracks not supported in connect engine yet",
            ),
        ).toBe(true);
    });
    it("does not flag unrelated errors", () => {
        expect(_forTests.isSpogoUnsupportedError("auth failed")).toBe(false);
        expect(_forTests.isSpogoUnsupportedError("network timeout")).toBe(false);
        expect(_forTests.isSpogoUnsupportedError("")).toBe(false);
    });
});
