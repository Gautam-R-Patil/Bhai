// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import {
    getDynamicToolSchemas,
    registerDynamicTool,
    setRegistryRef,
    unregisterDynamicTool,
} from "../../tools/create-tool.js";
import type { ToolDefinition } from "../../tools/get-current-time.js";

const def = (name: string): ToolDefinition => ({
    schema: { type: "function", function: { name, description: name, parameters: {} } },
    handler: async () => "",
});

describe("dynamic tool registry", () => {
    it("offers registered dynamic tools, not built-ins, and drops revoked ones", () => {
        const registry = new Map([["get_current_time", def("get_current_time")]]);
        setRegistryRef(registry);
        registerDynamicTool("made_today", def("made_today"));
        registerDynamicTool("approved_tool", def("approved_tool"));
        expect(getDynamicToolSchemas().map((s) => s.function.name)).toEqual(["made_today", "approved_tool"]);

        unregisterDynamicTool("approved_tool"); // revokeDynamicTool
        expect(getDynamicToolSchemas().map((s) => s.function.name)).toEqual(["made_today"]);
    });

    it("never replaces or removes a built-in", () => {
        const builtin = def("web_search");
        const registry = new Map([["web_search", builtin]]);
        setRegistryRef(registry);
        expect(registerDynamicTool("web_search", def("web_search"))).toBe(false);
        unregisterDynamicTool("web_search");
        expect(registry.get("web_search")).toBe(builtin);
        expect(getDynamicToolSchemas().map((s) => s.function.name)).not.toContain("web_search");
    });
});
