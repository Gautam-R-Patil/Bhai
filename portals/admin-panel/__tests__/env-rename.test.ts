// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// ATLAS_ → BHAI_ rename: deployments that still set the old names keep working.
import { afterEach, describe, expect, it } from "vitest";
import { adminBaseUrl, adminKey } from "../src/lib/convex";

const NAMES = ["BHAI_ADMIN_KEY", "ATLAS_ADMIN_KEY", "NEXT_PUBLIC_BHAI_ADMIN_API_BASE", "NEXT_PUBLIC_ATLAS_ADMIN_API_BASE"];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

describe("admin env names", () => {
    afterEach(() => {
        for (const n of NAMES) {
            if (saved[n] === undefined) delete process.env[n];
            else process.env[n] = saved[n];
        }
    });

    it("prefers BHAI_ and falls back to ATLAS_", () => {
        for (const n of NAMES) delete process.env[n];
        process.env.ATLAS_ADMIN_KEY = "old-key";
        process.env.NEXT_PUBLIC_ATLAS_ADMIN_API_BASE = "https://old.example/";
        expect(adminKey()).toBe("old-key");
        expect(adminBaseUrl()).toBe("https://old.example");
        process.env.BHAI_ADMIN_KEY = "new-key";
        process.env.NEXT_PUBLIC_BHAI_ADMIN_API_BASE = "https://new.example";
        expect(adminKey()).toBe("new-key");
        expect(adminBaseUrl()).toBe("https://new.example");
    });
});
