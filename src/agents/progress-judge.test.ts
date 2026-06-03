// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { MODELS } from "../llm.js";
import {
    buildActionObservationDigests,
    judgeFixToIntervention,
    progressJudgeEnabled,
    runProgressJudge,
} from "./progress-judge.js";

function fakeCompletion(content: string): ChatCompletion {
    return {
        id: "x",
        choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content, refusal: null } }],
        created: 0,
        model: "test",
        object: "chat.completion",
    } as unknown as ChatCompletion;
}

function makeLLM(chat: LLMClient["chat"]): LLMClient {
    return { chat, config: {} as LLMClient["config"] };
}

describe("progress-judge — gate + mapping", () => {
    afterEach(() => {
        delete process.env.ATLAS_PROGRESS_JUDGE;
    });

    it("progressJudgeEnabled reflects ATLAS_PROGRESS_JUDGE", () => {
        delete process.env.ATLAS_PROGRESS_JUDGE;
        expect(progressJudgeEnabled()).toBe(false);
        process.env.ATLAS_PROGRESS_JUDGE = "true";
        expect(progressJudgeEnabled()).toBe(true);
        process.env.ATLAS_PROGRESS_JUDGE = "1";
        expect(progressJudgeEnabled()).toBe(false); // only exact "true"
    });

    it("judgeFixToIntervention maps each fix onto the dispatcher enum", () => {
        expect(judgeFixToIntervention("retry")).toBe("none");
        expect(judgeFixToIntervention("replan")).toBe("replan");
        expect(judgeFixToIntervention("escalate")).toBe("escalate");
        expect(judgeFixToIntervention("ask_user")).toBe("ask_user");
    });

    it("buildActionObservationDigests pulls the last ≤6 action/observation pairs", () => {
        const messages: ChatCompletionMessageParam[] = [
            { role: "user", content: "do the thing" },
            { role: "assistant", content: "thinking about it" },
            { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] } as ChatCompletionMessageParam,
            { role: "tool", tool_call_id: "1", content: "file contents here" } as ChatCompletionMessageParam,
        ];
        const digest = buildActionObservationDigests(messages, 6);
        expect(digest).toContain("ACT: read_file");
        expect(digest).toContain("OBS: file contents here");
    });
});

describe("progress-judge — runProgressJudge", () => {
    const msgs: ChatCompletionMessageParam[] = [{ role: "assistant", content: "stuck" }];

    beforeEach(() => {
        delete process.env.ATLAS_PROGRESS_JUDGE;
    });

    it("parses a well-formed JSON verdict and clamps progress to [0,100]", async () => {
        const llm = makeLLM(
            vi.fn(async () =>
                fakeCompletion('{"progress_0_100": 250, "stalled": true, "likely_fix": "replan", "one_line": "going in circles"}'),
            ),
        );
        const v = await runProgressJudge(llm, "build a thing", msgs);
        expect(v).not.toBeNull();
        expect(v?.progress_0_100).toBe(100); // clamped
        expect(v?.stalled).toBe(true);
        expect(v?.likely_fix).toBe("replan");
        expect(v?.one_line).toBe("going in circles");
    });

    it("returns null (fail-open) on malformed / non-JSON content", async () => {
        const llm = makeLLM(vi.fn(async () => fakeCompletion("I think you're doing fine, no JSON here.")));
        expect(await runProgressJudge(llm, "goal", msgs)).toBeNull();
    });

    it("returns null when likely_fix is out of the allowlist", async () => {
        const llm = makeLLM(
            vi.fn(async () => fakeCompletion('{"progress_0_100": 10, "stalled": true, "likely_fix": "nuke", "one_line": "x"}')),
        );
        expect(await runProgressJudge(llm, "goal", msgs)).toBeNull();
    });

    it("returns null (fail-open) when chat() throws", async () => {
        const llm = makeLLM(
            vi.fn(async () => {
                throw new Error("network down");
            }),
        );
        expect(await runProgressJudge(llm, "goal", msgs)).toBeNull();
    });

    it("calls Haiku with thinkingLevel off and json_object response format", async () => {
        const chat: LLMClient["chat"] = vi.fn(async (_params) =>
            fakeCompletion('{"progress_0_100": 40, "stalled": false, "likely_fix": "escalate", "one_line": "slow"}'),
        );
        const llm = makeLLM(chat);
        await runProgressJudge(llm, "goal", msgs);
        const spy = chat as unknown as ReturnType<typeof vi.fn>;
        expect(spy).toHaveBeenCalledTimes(1);
        const params = spy.mock.calls[0][0] as Parameters<LLMClient["chat"]>[0];
        expect(params.modelOverride).toBe(MODELS.HAIKU);
        expect(params.thinkingLevel).toBe("off");
        expect(params.responseFormat).toBe("json_object");
    });
});
