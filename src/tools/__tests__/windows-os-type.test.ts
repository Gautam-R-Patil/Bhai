// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const scripts: string[] = [];
vi.mock("../platform.js", () => ({
    captureScreenshot: vi.fn(),
    getFrontmostApp: vi.fn(),
    getScreenResolution: vi.fn(),
    runPowerShellInline: vi.fn(),
    runPowerShell: vi.fn(async (script: string) => {
        scripts.push(script);
        return "";
    }),
}));

const { winOsType } = await import("../windows.js");
const realPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => Object.defineProperty(process, "platform", { value: realPlatform }));

describe("Windows os_type never splices untrusted text into PowerShell", () => {
    it.each([
        { text: `hi"); Start-Process calc; ("` },
        { text: "$(Start-Process calc) `whoami` नमस्ते" },
        { key: `x")}; Start-Process calc; #` },
        { combo: `ctrl+x"); Start-Process calc; ("` },
        { text: "ok", delay_ms: "1; Start-Process calc" },
    ])("%o", async (input) => {
        scripts.length = 0;
        await winOsType.handler(input as Record<string, unknown>);
        expect(scripts).toHaveLength(1);
        expect(scripts[0]).not.toContain("Start-Process");
        expect(scripts[0]).not.toContain("$(");
        expect(scripts[0]).toMatch(/^[\x00-\x7f]*$/); // ASCII-only script: no code-page mangling
    });
});
