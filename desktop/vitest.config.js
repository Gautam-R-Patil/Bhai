// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.js"],
        globals: false,
        testTimeout: 5000,
    },
});
