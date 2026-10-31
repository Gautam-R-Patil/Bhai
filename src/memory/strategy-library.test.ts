// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getStrategy, saveStrategy } from "./strategy-library.js";

// Fake timers so saveStrategy's debounced writeFileSync never touches ~/.bhai.
beforeAll(() => vi.useFakeTimers());
afterAll(() => vi.useRealTimers());

describe("getStrategy — empty/whitespace query", () => {
    beforeAll(() => {
        saveStrategy({
            pattern: "play_song_spotify",
            description: "Play a song on Spotify",
            steps: ["spotify:play"],
            success: true,
            tags: ["spotify", "music"],
        });
    });

    it("returns null for an empty query instead of matching every strategy", () => {
        expect(getStrategy("")).toBeNull();
    });

    it("returns null for a whitespace-only query", () => {
        expect(getStrategy("   ")).toBeNull();
    });

    it("still matches a real query", () => {
        const s = getStrategy("play song spotify");
        expect(s?.pattern).toBe("play_song_spotify");
    });
});
