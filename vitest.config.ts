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
            "src/screen/**/*.test.ts",
            "src/__tests__/**/*.test.ts",
            "convex/**/*.test.ts",
        ],
        environment: "node",
        testTimeout: 30_000,
        reporters: ["verbose"],
    },
});
