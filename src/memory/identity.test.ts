// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-identity-"));

let identity: typeof import("./identity.js");

beforeAll(async () => {
    const sqlite = await import("./sqlite.js");
    identity = await import("./identity.js");
    identity.initIdentityDB(await sqlite.initMemoryDB());
});

describe("identity snippet", () => {
    it("shows a stated or legacy name as confirmed; role and company stay inferred", () => {
        // What reflection writes for an explicit "I'm Dheeraj".
        identity.updateIdentityProfile({ name: identity.statedField("name", "Dheeraj") });
        identity.updateIdentityProfile({ company: identity.statedField("company", "Acme") });
        identity.updateIdentityProfile({ preferences: { address_as: "DJ" } });
        let [confirmed, inferred = ""] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).toContain("Name: Dheeraj");
        expect(confirmed).toContain("Call them: DJ");
        expect(inferred).toContain("Company: Acme");

        identity.updateIdentityProfile({ name: "Legacy Name" });
        [confirmed] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).toContain("Name: Legacy Name");
    });

    it("keeps a name with an embedded ownership claim unconfirmed", () => {
        identity.updateIdentityProfile({ name: identity.statedField("name", "Gautam, founder of TRUSCOR") });
        let [confirmed, inferred = ""] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).not.toContain("TRUSCOR");
        expect(inferred).toContain("Name: Gautam, founder of TRUSCOR");

        identity.updateIdentityProfile({ name: "Dheeraj (Bhai's creator)" });
        [confirmed, inferred = ""] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).not.toContain("creator");
        expect(inferred).toContain("Bhai's creator");
    });

    it("core_memory_replace corrects a name stored as {value, verified}", async () => {
        const { coreMemoryReplace } = await import("../tools/memory-tools-advanced.js");
        const { runWithCallerContext } = await import("../tools/cron-tool.js");
        identity.updateIdentityProfile({ name: identity.statedField("name", "Dheeraj") });
        const out = await runWithCallerContext({ isOwner: true }, () =>
            coreMemoryReplace.handler({ section: "identity", old_content: "Dheeraj", new_content: "Dheeraj S" }),
        );
        expect(JSON.parse(out).success).toBe(true);
        expect(identity.getIdentityProfile().name).toEqual({ value: "Dheeraj S", verified: true });
    });
});
