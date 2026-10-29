// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { defineConfig } from "vitest/config";
import path from "node:path";

// JWT_SECRET is asserted at module-load time by src/lib/auth.ts. For tests we
// inject a 48-char placeholder that satisfies the validation rules so the
// module can be imported.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-this-is-definitely-not-the-default-okay-fine";

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
