import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/gmail-stale-fetch.js", () => ({
    fetchStaleEmails: vi.fn(async () => ({
        stale: [
            { id: "m1", from: "boss@corp.com", subject: "Q3 Review", receivedMs: Date.now() - 5 * 86400_000, isImportant: true, threadMsgCount: 1 },
            { id: "m2", from: "partner@co.io", subject: "Integration proposal", receivedMs: Date.now() - 8 * 86400_000, isImportant: false, threadMsgCount: 2 },
        ],
        engaged_senders: ["boss@corp.com"],
    })),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    staleEmailScore: vi.fn((_emails: unknown[], _engaged: unknown[], _now: number) => [
        { id: "m1", from: "boss@corp.com", subject: "Q3 Review", daysStale: 5, score: 0.9 },
        { id: "m2", from: "partner@co.io", subject: "Integration proposal", daysStale: 8, score: 0.7 },
    ]),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { STALE_EMAIL } from "./stale-email.js";

describe("stale-email source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits stale_email_draft review intents for top candidates", async () => {
        const intents = await STALE_EMAIL.collectIntents({ now: Date.now() });
        expect(intents.length).toBeGreaterThanOrEqual(1);
        expect(intents.length).toBeLessThanOrEqual(3);
        expect(intents[0].payload.kind).toBe("stale_email_draft");
        expect(intents[0].source).toBe("stale_email");
        expect(intents[0].mode).toBe("review");
        expect(intents[0].suggestedAction).toBeDefined();
        expect(intents[0].suggestedAction!.toolCalls.length).toBeGreaterThan(0);
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await STALE_EMAIL.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no stale emails", async () => {
        const fetchMod = await import("./_shared/gmail-stale-fetch.js");
        (fetchMod.fetchStaleEmails as any).mockResolvedValueOnce({ stale: [], engaged_senders: [] });
        const intents = await STALE_EMAIL.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when score returns no candidates", async () => {
        const native = await import("../../../native/index.js");
        (native.staleEmailScore as any).mockReturnValueOnce([]);
        const intents = await STALE_EMAIL.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
