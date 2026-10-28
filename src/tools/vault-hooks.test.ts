// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// User hooks never see a saved secret, and can't rewrite a call that types one
// (the vault checked the origin for the input as it was).
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "Gh-Secret-77!";
const seen: Record<string, unknown>[] = [];
const hookSaw: unknown[] = [];
vi.mock("./browser/human-handoff.js", () => ({
    browserWaitForHuman: {
        schema: { type: "function", function: { name: "browser_wait_for_human", parameters: { type: "object", properties: {} } } },
        handler: async (input: Record<string, unknown>) => {
            seen.push(input);
            return JSON.stringify({ status: "cleared" });
        },
    },
}));
vi.mock("../hooks/index.js", async (orig) => ({
    ...(await orig<object>()),
    firePreToolUse: async (_n: string, input: Record<string, unknown>) => {
        hookSaw.push(JSON.parse(JSON.stringify(input)));
        return { modifiedInput: { ...input, text: "something else" } };
    },
    firePostToolUse: async (_n: string, input: Record<string, unknown>) => {
        hookSaw.push(JSON.parse(JSON.stringify(input)));
        return {};
    },
}));

const { executeTool } = await import("./index.js");
const { handleDesktopLine, runVaultCall } = await import("../security/vault.js");

beforeEach(() => {
    seen.length = 0;
    hookSaw.length = 0;
    handleDesktopLine(
        `##BHAI_VAULT##${JSON.stringify([{ id: "gh", label: "GitHub", kind: "login", domains: ["github.com"], username: "octo-dev", password: SECRET }])}`,
    );
});

describe("hooks and vault calls", () => {
    it("hooks get tokens, not values, and their rewrite is ignored", async () => {
        const call = { tool: "browser_wait_for_human", rules: [{ token: "{{vault:gh.password}}", domains: ["github.com"], payment: false }] };
        await runVaultCall(call, () => executeTool("browser_wait_for_human", { text: SECRET }));
        await new Promise((r) => setTimeout(r, 10)); // PostToolUse is fire-and-forget
        expect(JSON.stringify(hookSaw)).not.toContain(SECRET);
        expect(JSON.stringify(hookSaw)).toContain("{{vault:gh.password}}");
        expect(seen[0].text).toBe(SECRET);
    });
    it("outside a vault call, hooks still see and rewrite the input", async () => {
        await executeTool("browser_wait_for_human", { text: "hello" });
        expect(seen[0].text).toBe("something else");
    });
});
