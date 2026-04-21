// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/video-studio/**/*.test.ts", "src/tools/**/*.test.ts", "src/setup/**/*.test.ts", "src/proactive/**/*.test.ts", "src/memory/**/*.test.ts"],
        environment: "node",
        testTimeout: 30_000,
        reporters: ["verbose"],
    },
});
