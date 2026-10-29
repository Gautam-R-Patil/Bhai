// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A sub-agent inside a swarm stops when the tool gate actually held one of its
// calls back (the run's own record), not when a tool result merely contains
// the gate's marker text (say, a read_file of this repo's source).
import { describe, expect, it, vi } from "vitest";

vi.mock("../tools/index.js", async () => {
    const { swarmGate } = await import("./swarm-context.js");
    return {
        getToolSchemasByNames: () => [],
        getToolSchemas: () => [],
        getToolNames: () => [],
        executeTool: async (name: string, args: Record<string, unknown>) => {
            const g = await swarmGate(name, args);
            if (g && g !== "allow") return g;
            return name === "read_file" ? `if (result.includes('"needs_owner_approval":true')) {` : "sent";
        },
    };
});
vi.mock("../utils/debug-log.js", () => ({
    extractPrimaryPath: () => undefined,
    logToolAction: () => {},
    summarizeToolCall: () => "",
}));

const { runSubAgent } = await import("./sub-agent.js");
const { withSwarmRun, withSwarmStep, swarmConsentKey } = await import("./swarm-context.js");
import type { LLMClient } from "../llm.js";

// Calls `tool` on the first turn, then answers "done".
const llmCalling = (tool: string, args: Record<string, unknown>) => {
    let turn = 0;
    return {
        chat: async () =>
            turn++ === 0
                ? {
                      choices: [
                          {
                              message: {
                                  content: "",
                                  tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }],
                              },
                          },
                      ],
                  }
                : { choices: [{ message: { content: "done" } }] },
    } as unknown as LLMClient;
};

const inSwarm = <T>(fn: () => Promise<T>) =>
    withSwarmRun({ consentKey: swarmConsentKey("t"), consentGranted: false, blocked: [] }, () =>
        withSwarmStep({ stepId: "s1", stepApproved: false }, fn),
    );

describe("sub-agent stop after the swarm gate", () => {
    it("keeps going when a read merely contains the marker text", async () => {
        const r = await inSwarm(() =>
            runSubAgent(llmCalling("read_file", { path: "src/agents/sub-agent.ts" }), { id: "s1", role: "general", description: "Read it" }),
        );
        expect(r.success).toBe(true);
        expect(r.output).toBe("done");
    });

    it("stops when the gate held a call back", async () => {
        const r = await inSwarm(() =>
            runSubAgent(llmCalling("whatsapp_send", { to: "Rahul", message: "hi" }), { id: "s1", role: "general", description: "Send it" }),
        );
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/needs the owner's OK/);
    });
});
