// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A contact's or guest's words never become the owner's goals or session context.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendTurn, createGoal, storeImage, wmReflect } = vi.hoisted(() => ({
    appendTurn: vi.fn(),
    createGoal: vi.fn(),
    storeImage: vi.fn(),
    wmReflect: vi.fn(async () => {}),
}));
vi.mock("./account-guard.js", async (orig) => ({
    ...(await orig<typeof import("./account-guard.js")>()),
    checkAccountStatus: async () => ({ allowed: true }),
}));
vi.mock("./memory/session.js", async (orig) => ({ ...(await orig<object>()), appendTurn }));
vi.mock("./memory/goals.js", async (orig) => ({ ...(await orig<object>()), createGoal }));
vi.mock("./memory/multimodal-embedding.js", async (orig) => ({
    ...(await orig<object>()),
    storeImageEmbedding: storeImage,
}));
vi.mock("./memory/working-memory.js", async (orig) => ({ ...(await orig<object>()), reflect: wmReflect }));
vi.mock("./memory/embeddings.js", async (orig) => ({ ...(await orig<object>()), embedText: async () => [0.1, 0.2] }));

import { runAgent } from "./agent.js";
import type { LLMClient } from "./llm.js";

const llm = {
    chat: async () => ({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
} as unknown as LLMClient;
const GOAL = "I want to lose 5 kg by March, help me plan it";
const PHOTO = [{ type: "image" as const, base64: "iVBORw0KGgo=", mimeType: "image/png" }];

describe("owner-only state", () => {
    beforeEach(() => {
        appendTurn.mockClear();
        createGoal.mockClear();
        storeImage.mockClear();
        wmReflect.mockClear();
    });

    it("a WhatsApp contact's message doesn't touch the owner's goals or session", async () => {
        await runAgent(llm, GOAL, undefined, PHOTO, undefined, [], undefined, undefined, {
            channel: "whatsapp",
            userId: "contact-1",
            isOwner: false,
        });
        expect(createGoal).not.toHaveBeenCalled();
        expect(appendTurn).not.toHaveBeenCalled();
        expect(storeImage).not.toHaveBeenCalled(); // their photo isn't the owner's image memory
        expect(wmReflect).not.toHaveBeenCalled(); // nor the owner's working memory
    }, 60_000);

    it("the owner's own message still does", async () => {
        await runAgent(llm, GOAL, undefined, PHOTO, undefined, undefined, undefined, undefined, {
            channel: "telegram",
            userId: "owner",
            isOwner: true,
        });
        expect(createGoal).toHaveBeenCalled();
        expect(appendTurn).toHaveBeenCalledWith("user", expect.stringContaining("lose 5 kg"));
        expect(storeImage).toHaveBeenCalled();
        expect(wmReflect).toHaveBeenCalled();
    }, 60_000);
});
