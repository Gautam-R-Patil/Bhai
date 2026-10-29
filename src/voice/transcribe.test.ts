// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Without a local Whisper key, transcription goes to the server's /api/stt
// (never the LLM proxy, which drops audio); a 503 there means "not set up".
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../session.js", () => ({ getSessionToken: async () => "tok" }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://site.example" }));
vi.mock("../crypto-transport.js", () => ({ encryptedFetch: (...a: unknown[]) => fetchMock(...a) }));

describe("transcribeBuffer without a local key", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        fetchMock.mockReset();
    });

    it("uses the server endpoint and returns its text", async () => {
        vi.stubEnv("OPENAI_API_KEY", "");
        vi.stubEnv("GROQ_API_KEY", "");
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: " hi bhai " }), { status: 200 }));
        const { transcribeBuffer } = await import("./transcribe.js");
        await expect(transcribeBuffer(Buffer.from("ogg"), "voice.ogg")).resolves.toBe("hi bhai");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://site.example/api/stt");
        expect(JSON.parse(String(init.body))).toMatchObject({ mimeType: "audio/ogg", filename: "voice.ogg" });
    });

    it("says it isn't set up when the server has no STT provider", async () => {
        vi.stubEnv("OPENAI_API_KEY", "");
        vi.stubEnv("GROQ_API_KEY", "");
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "stt_not_configured" }), { status: 503 }));
        const { transcribeBuffer, STT_NOT_CONFIGURED } = await import("./transcribe.js");
        await expect(transcribeBuffer(Buffer.from("ogg"), "voice.ogg")).rejects.toThrow(STT_NOT_CONFIGURED);
    });
});
