// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
        identity.updateIdentityProfile({ name: identity.statedField("name", "Dheeraj, founder of XAGI Labs") });
        let [confirmed, inferred = ""] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).not.toContain("XAGI");
        expect(inferred).toContain("Name: Dheeraj, founder of XAGI Labs");

        identity.updateIdentityProfile({ name: "Dheeraj (Bhai's creator)" });
        [confirmed, inferred = ""] = identity.getIdentityPromptSnippet().split("⚠️");
        expect(confirmed).not.toContain("creator");
        expect(inferred).toContain("Bhai's creator");
    });
});
