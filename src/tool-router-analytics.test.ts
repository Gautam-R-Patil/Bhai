// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "tool-analytics-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));

describe("tool-router-analytics", () => {
    it("loads learned intents from a v3 file that still carries the dropped usage/failure fields", async () => {
        mkdirSync(join(home, ".atlas", "data"), { recursive: true });
        writeFileSync(
            join(home, ".atlas", "data", "tool-analytics.json"),
            JSON.stringify({
                matrix: { a: { b: 9 } },
                recentUsage: [],
                preferences: {
                    intentToolMap: { music: { spotify: 5 } },
                    intentToolTimestamps: { music: { spotify: Date.now() } },
                    toolFailures: { spotify: { failureCount: 9 } },
                },
                version: 3,
            }),
        );
        const { getPreferredTools, getFollowUpTools, getLikelyCategories } = await import("./tool-router-analytics.js");

        expect(getPreferredTools("music", ["music_control", "spotify"])).toEqual(["spotify", "music_control"]);
        expect(getFollowUpTools(["spotify"])).toEqual([]); // followUpPatterns missing → defaulted, no throw
        expect(getLikelyCategories(["shell", "file_system"])).toEqual(["browser"]); // code_project chain
        expect(getLikelyCategories(["voice"])).toEqual([]);
    });
});
