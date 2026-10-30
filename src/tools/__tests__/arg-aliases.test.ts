// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// gpt-4.1-nano called write with "path" five times and was refused each time.
import { describe, expect, it } from "vitest";

const { withArgAliases } = await import("../index.js");

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
