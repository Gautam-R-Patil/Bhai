// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { gateVerdict, hardAllow, hardReject } from "./value-gate.js";

const brandJson = JSON.stringify({ name: "Acme", tone: "bold", colors: ["#000"] });

describe("value-gate precedence (gateVerdict)", () => {
    it("exposes the raw hardReject/hardAllow contradiction the ordering caused", () => {
        // Same input: hardReject drops it (pure_json) while hardAllow admits it.
        expect(hardReject(brandJson, "user", 10, "brand").reject).toBe(true);
        expect(hardAllow(brandJson, "user", 10, "brand").allow).toBe(true);
    });

    it("lets an explicit allow override a shape-based reject (curated pure JSON)", () => {
        const v = gateVerdict(brandJson, "user", 10, "brand");
        expect(v.verdict).toBe("allow");
    });

    it("lets an allow override the oversize reject for reflection summaries", () => {
        const big = "x".repeat(2500);
        const v = gateVerdict(big, "reflection", 7, "session_summary");
        expect(v.verdict).toBe("allow");
    });

    it("keeps unconditional rejects winning even for curated/high-importance content", () => {
        const blob = `{"screenshot_base64":"${"A".repeat(50)}"}`;
        const v = gateVerdict(blob, "user", 10, "brand");
        expect(v.verdict).toBe("reject");
        expect(v.reason).toBe("binary_blob");
    });

    it("still rejects uncurated pure JSON / oversize content", () => {
        expect(gateVerdict(brandJson, "user", 3, "general").verdict).toBe("reject");
        expect(gateVerdict("x".repeat(2500), "user", 3, "general").verdict).toBe("reject");
    });

    it("returns undecided for ordinary short content (falls through to LLM gate)", () => {
        const v = gateVerdict("I prefer tea over coffee", "user", 5, "general");
        expect(v.verdict).toBe("undecided");
    });
});
