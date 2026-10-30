// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// An approved persisted tool passes its own tamper check (the hash covers the bytes
// actually written), and "don't approve this" is not an approval.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.ATLAS_HOME = mkdtempSync(path.join(tmpdir(), "atlas-forge-hash-"));
const { installPersistedTool, wrapHandler } = await import("../sandbox-supervisor.js");
const { manifestDir } = await import("../manifest.js");
const { noteOwnerMessage, ownerApproved } = await import("../../security/consent.js");

const sha16 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex").substring(0, 16);

describe("persisted tool hash", () => {
    it("is the hash of handler.js as written", async () => {
        const code = "return { ok: input.x * 2 };";
        const manifest = {
            slug: "double_it",
            description: "Doubles x",
            version: "1.0.0",
            approvedAt: Date.now(),
            userQuote: "yes approve it",
            handlerHash: sha16(wrapHandler(code)),
            parametersSchema: { type: "object", properties: { x: { type: "number" } } },
            capabilities: { network: [], fs: [] },
        } as never;
        await installPersistedTool("double_it", code, manifest);
        expect(sha16(readFileSync(path.join(manifestDir("double_it"), "handler.js")))).toBe(sha16(wrapHandler(code)));
        expect(sha16(wrapHandler(code))).not.toBe(sha16(code)); // what it used to compare against
    });
});

describe("tool approval", () => {
    it("needs a yes, not just words the owner said", () => {
        const since = Date.now() - 1;
        noteOwnerMessage("don't approve this yet, explain what it does");
        expect(ownerApproved("don't approve this yet", since)).toBe(false);
        noteOwnerMessage("yes, approve it");
        expect(ownerApproved("approve it", since)).toBe(true);
    });
});
