// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// gpt-4.1-nano called write with "path" five times and was refused each time.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { withArgAliases, withHomePaths } = await import("../index.js");

describe("withArgAliases", () => {
    it("fills a required key from the name a model used", () => {
        expect(withArgAliases("write", { path: "/tmp/x.txt", content: "hi" })).toMatchObject({ file_path: "/tmp/x.txt" });
        expect(withArgAliases("write", { file_path: "/tmp/a.txt", text: "hi" })).toMatchObject({ content: "hi" });
    });
    it("leaves a call that already has the key alone", () => {
        const call = { file_path: "/tmp/a.txt", path: "/tmp/b.txt", content: "x" };
        expect(withArgAliases("write", call)).toBe(call);
    });
});

// Full-50 PLAN run: "Bhai × TinyFish — Pitch Deck.pdf" came back as "Bhai \u0019TinyFish \u0000…" six times.
describe("garbled file names", () => {
    it("are the one file with the same letters and digits; other names are left alone", () => {
        const dir = mkdtempSync(join(homedir(), ".bhai-garble-"));
        try {
            const real = join(dir, "Bhai × TinyFish — Pitch Deck.pdf");
            writeFileSync(real, "x");
            expect(withHomePaths({ path: join(dir, "Bhai \u0019TinyFish \u0000Pitch Deck.pdf") }).path).toBe(real);
            // A new file with a near name is never redirected onto an existing one.
            const fresh = join(dir, "Bhai TinyFish Pitch Deck.pdf");
            expect(withHomePaths({ path: fresh }).path).toBe(fresh);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
