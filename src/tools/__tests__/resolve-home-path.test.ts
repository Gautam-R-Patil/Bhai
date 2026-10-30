// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// From the model-ladder eval: gpt-4.1-nano opened "/Users/your_username/Downloads".
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveHomePath } from "../file-utils.js";

describe("resolveHomePath", () => {
    const real = mkdtempSync(join(homedir(), ".bhai-home-test-"));
    const name = real.slice(homedir().length + 1);
    afterAll(() => rmSync(real, { recursive: true, force: true }));

    it("maps a placeholder home to the real one when only that exists", () => {
        expect(resolveHomePath(`/Users/your_username/${name}`)).toBe(real);
        expect(resolveHomePath(`/home/user/${name}`)).toBe(real);
        expect(resolveHomePath(`~/${name}`)).toBe(real);
    });

    it("leaves paths that exist, or exist nowhere, alone", () => {
        const tmp = mkdtempSync(join(tmpdir(), "bhai-"));
        expect(resolveHomePath(tmp)).toBe(tmp);
        expect(resolveHomePath("/Users/someone/definitely-not-here-xyz")).toBe("/Users/someone/definitely-not-here-xyz");
    });
});

// From the complex-task eval: list_directory("~/Downloads") read "<cwd>/~/Downloads".
describe("withHomePaths (every tool call)", () => {
    it("resolves ~ in path arguments and leaves the rest alone", async () => {
        const { withHomePaths } = await import("../index.js");
        const out = withHomePaths({ path: "~/Downloads", query: "~/not-a-path", target: "https://x.y/~a" });
        expect(out.path).toBe(join(homedir(), "Downloads"));
        expect(out.query).toBe("~/not-a-path");
        expect(out.target).toBe("https://x.y/~a");
    });
});
