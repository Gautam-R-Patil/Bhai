// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { mirrorLegacyEnv } from "./env-compat.js";

describe("mirrorLegacyEnv", () => {
    it("copies ATLAS_X to an unset BHAI_X and back", () => {
        const env: NodeJS.ProcessEnv = { ATLAS_NO_FORGE: "true", BHAI_DATA_DIR: "/d" };
        mirrorLegacyEnv(env);
        expect(env.BHAI_NO_FORGE).toBe("true");
        expect(env.ATLAS_DATA_DIR).toBe("/d");
    });

    it("never overwrites a name that is already set, even to an empty string", () => {
        const env: NodeJS.ProcessEnv = { ATLAS_WORKSPACE: "/old", BHAI_WORKSPACE: "", ATLAS_X: "a", BHAI_X: "b" };
        mirrorLegacyEnv(env);
        expect(env.BHAI_WORKSPACE).toBe("");
        expect(env.BHAI_X).toBe("b");
        expect(env.ATLAS_X).toBe("a");
    });

    it("ignores other keys", () => {
        const env: NodeJS.ProcessEnv = { ATLASX: "1", MY_ATLAS_Y: "2" };
        mirrorLegacyEnv(env);
        expect(env).toEqual({ ATLASX: "1", MY_ATLAS_Y: "2" });
    });
});
