// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getParser, listParsers } from "./index.js";

describe("parser registry", () => {
    it("exposes chatml_xml", () => {
        const p = getParser("chatml_xml");
        expect(p).toBeDefined();
        expect(typeof p.parse).toBe("function");
    });

    it("exposes qwen3_coder", () => {
        expect(getParser("qwen3_coder")).toBeDefined();
    });

    it("exposes llama3_json", () => {
        expect(getParser("llama3_json")).toBeDefined();
    });

    it("exposes deepseek_v3_1", () => {
        expect(getParser("deepseek_v3_1")).toBeDefined();
    });

    it("throws on unknown parser", () => {
        expect(() => getParser("__nope__")).toThrow(/Unknown parser/);
    });

    it("listParsers returns sorted names including all four", () => {
        const names = listParsers();
        for (const n of [
            "chatml_xml",
            "deepseek_v3_1",
            "llama3_json",
            "qwen3_coder",
        ]) {
            expect(names).toContain(n);
        }
    });
});
