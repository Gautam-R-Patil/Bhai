// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import * as installer from "../../store/installer.js";

describe("installer accepts dynamic type", () => {
    it("exports DYNAMIC_PATH constant pointing at the right place", () => {
        const exported = (installer as any).DYNAMIC_PATH as string | undefined;
        expect(exported).toBe(join(homedir(), ".bhai", "store", "dynamic"));
    });
});
