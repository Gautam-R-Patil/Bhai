// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Saving the WhatsApp persona from Settings must not wipe allowedToolNames
// (customized by the owner via the WhatsApp "set tools" command) — the form
// only sends {name, systemPrompt, autoAllow}, so the save must merge.
import { describe, it, expect } from "vitest";
import { mergeWaPersona } from "../wa-persona-merge.js";

describe("mergeWaPersona", () => {
    it("preserves allowedToolNames the form does not send", () => {
        const existing = { name: "Old", systemPrompt: "x", allowedToolNames: ["a", "b"], autoAllow: true };
        const incoming = { name: "New", systemPrompt: "y", autoAllow: false };
        const out = mergeWaPersona(existing, incoming);
        expect(out.allowedToolNames).toEqual(["a", "b"]);
        expect(out.name).toBe("New");
        expect(out.systemPrompt).toBe("y");
        expect(out.autoAllow).toBe(false);
    });

    it("lets an explicit allowedToolNames override", () => {
        const out = mergeWaPersona({ allowedToolNames: ["a"] }, { allowedToolNames: ["c"] });
        expect(out.allowedToolNames).toEqual(["c"]);
    });

    it("ignores undefined fields in the update", () => {
        const out = mergeWaPersona({ name: "Keep" }, { name: undefined, autoAllow: true });
        expect(out.name).toBe("Keep");
        expect(out.autoAllow).toBe(true);
    });

    it("handles missing existing / incoming", () => {
        expect(mergeWaPersona(null, { name: "N" })).toEqual({ name: "N" });
        expect(mergeWaPersona({ name: "E" }, null)).toEqual({ name: "E" });
    });
});
