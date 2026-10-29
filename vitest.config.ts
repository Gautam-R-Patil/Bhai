// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "src/*.test.ts",
            "src/video-studio/**/*.test.ts",
            "src/tools/**/*.test.ts",
            "src/setup/**/*.test.ts",
            "src/proactive/**/*.test.ts",
            "src/memory/**/*.test.ts",
            "src/harness/**/*.test.ts",
            "src/security/**/*.test.ts",
            "src/utils/**/*.test.ts",
            "src/config/**/*.test.ts",
            "src/commands/**/*.test.ts",
            "src/agents/**/*.test.ts",
            "src/llm-parsers/**/*.test.ts",
            "src/cron/**/*.test.ts",
            "src/prompts/**/*.test.ts",
            "src/skills/**/*.test.ts",
            "src/voice/**/*.test.ts",
            "src/forge/**/*.test.ts",
            "src/store/**/*.test.ts",
            "src/screen/**/*.test.ts",
            "src/research/**/*.test.ts",
            "src/social/**/*.test.ts",
            "src/diagnostics/**/*.test.ts",
            "src/overlay/**/*.test.ts",
            "src/__tests__/**/*.test.ts",
            "convex/**/*.test.ts",
        ],
        environment: "node",
        testTimeout: 30_000,
        // Closing Chromium or an HTTP server can take >10s on a Windows runner.
        hookTimeout: 30_000,
        // CI only: absorb transient timing/resource flakes. A large pool of
        // tests assert hard wall-clock deadlines, drive real headless Chromium,
        // or kill a child by RSS/deadline — all deterministic on a quiet machine
        // but racy on a loaded shared runner (esp. Windows/Node 24), so a
        // different one reddens the matrix almost every run. Retry re-runs only
        // the failed test; a genuinely broken one still fails all three attempts.
        // Zero locally, so flakes stay visible during development, not masked.
        retry: process.env.CI ? 2 : 0,
        reporters: ["verbose"],
    },
});
