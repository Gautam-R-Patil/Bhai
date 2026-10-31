// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-identity-"));

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
        identity.updateIdentityProfile({ name: identity.statedField("name", "Dheeraj, founder of XAGI Labs") });
        let [confirmed, inferred = ""] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).not.toContain("XAGI");
        expect(inferred).toContain("Name: Dheeraj, founder of XAGI Labs");

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

    it("core_memory_delete clears an identity field and an extra key", async () => {
        const { coreMemoryDelete } = await import("../tools/memory-tools-advanced.js");
        const { runWithCallerContext } = await import("../tools/cron-tool.js");
        identity.updateIdentityProfile({
            location: identity.statedField("location", "Delhi"),
            extra: { kid_school: "DPS", keep: 1 },
        });
        for (const content of ["location", "kid_school"]) {
            const out = await runWithCallerContext({ isOwner: true }, () =>
                coreMemoryDelete.handler({ section: "identity", content }),
            );
            expect(JSON.parse(out).success).toBe(true);
        }
        const p = identity.getIdentityProfile();
        expect(p.location).toBeUndefined();
        expect(p.extra).toEqual({ keep: 1 });
        expect(identity.getIdentityPromptSnippet()).not.toContain("Delhi");
    });
});
