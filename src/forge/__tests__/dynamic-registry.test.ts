// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { getDynamicToolSchemas, registerDynamicTool, setRegistryRef } from "../../tools/create-tool.js";
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

        registry.delete("approved_tool"); // revokeDynamicTool
        expect(getDynamicToolSchemas().map((s) => s.function.name)).toEqual(["made_today"]);
    });
});
