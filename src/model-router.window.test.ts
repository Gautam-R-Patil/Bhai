// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getContextWindow, isNativeRouterLoaded } from "./model-router.js";

// P3.1: context_window is sourced from the native registry (or its TS fallback).
// These assert the values are present and sane, and that unknown ids fail open.
// Per-model windows live in the native registry; without the binary every id
// gets the 200K fail-open default, so the exact-value checks need native.
const withNative = it.skipIf(!isNativeRouterLoaded());

describe("getContextWindow", () => {
    withNative("returns the large window for 1M-class models", () => {
        expect(getContextWindow("anthropic/claude-opus-4.6")).toBeGreaterThanOrEqual(1_000_000);
        expect(getContextWindow("google/gemini-3.1-pro-preview-customtools")).toBeGreaterThanOrEqual(1_000_000);
    });

    it("returns the smaller window for 200K-class models", () => {
        expect(getContextWindow("anthropic/claude-haiku-4.5")).toBe(200_000);
        expect(getContextWindow("z-ai/glm-4.6")).toBe(200_000);
    });

    withNative("returns mid windows for GPT-5 / Nova / DeepSeek tiers", () => {
        expect(getContextWindow("openai/gpt-5-mini")).toBe(400_000);
        expect(getContextWindow("amazon/nova-pro-v1")).toBe(300_000);
        expect(getContextWindow("deepseek/deepseek-chat-v3.1")).toBe(160_000);
    });

    it("fails open to 200K for an unknown model id", () => {
        expect(getContextWindow("totally/made-up-model")).toBe(200_000);
        expect(getContextWindow("")).toBe(200_000);
    });

    it("never returns a non-positive window", () => {
        for (const id of ["anthropic/claude-opus-4.6", "anthropic/claude-haiku-4.5", "unknown/x"]) {
            expect(getContextWindow(id)).toBeGreaterThan(0);
        }
    });
});
