// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
        testTimeout: 10_000,
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
});
