// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// User hooks never see a saved secret, and can't rewrite a call that types one
// (the vault checked the origin for the input as it was).
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "Gh-Secret-77!";
const seen: Record<string, unknown>[] = [];
const hookSaw: unknown[] = [];
// Any registered tool will do; site_task is one that isn't a browser_* (no page check after it).
vi.mock("./site-task.js", () => ({
    siteTask: {
        schema: { type: "function", function: { name: "site_task", parameters: { type: "object", properties: {} } } },
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
        const call = { tool: "site_task", rules: [{ token: "{{vault:gh.password}}", domains: ["github.com"], payment: false }] };
        await runVaultCall(call, () => executeTool("site_task", { text: SECRET }));
        await new Promise((r) => setTimeout(r, 10)); // PostToolUse is fire-and-forget
        expect(JSON.stringify(hookSaw)).not.toContain(SECRET);
        expect(JSON.stringify(hookSaw)).toContain("{{vault:gh.password}}");
        expect(seen[0].text).toBe(SECRET);
    });
    it("outside a vault call, hooks still see and rewrite the input", async () => {
        await executeTool("site_task", { text: "hello" });
        expect(seen[0].text).toBe("something else");
    });
});
