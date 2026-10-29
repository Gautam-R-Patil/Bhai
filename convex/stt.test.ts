// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it, vi } from "vitest";
import { decodeBase64, sttConfigFromEnv, transcribeWithProvider } from "./stt";

describe("server speech-to-text", () => {
    it("is off without a key and defaults to OpenAI otherwise", () => {
        expect(sttConfigFromEnv({})).toBeNull();
        expect(sttConfigFromEnv({ STT_API_KEY: "k" })).toEqual({
            apiKey: "k",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini-transcribe",
        });
        expect(sttConfigFromEnv({ STT_API_KEY: "k", STT_BASE_URL: "https://api.groq.com/openai/v1/" })?.baseUrl).toBe(
            "https://api.groq.com/openai/v1",
        );
    });

    it("posts the audio as multipart to /audio/transcriptions and returns the text", async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ text: " hello there " }), { status: 200 }));
        const cfg = { apiKey: "k", baseUrl: "https://stt.example/v1", model: "m" };
        const text = await transcribeWithProvider(cfg, decodeBase64(btoa("ogg")), "audio/ogg", "voice.ogg", fetchFn);
        expect(text).toBe("hello there");
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://stt.example/v1/audio/transcriptions");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
        const form = init.body as FormData;
        expect(form.get("model")).toBe("m");
        expect((form.get("file") as File).name).toBe("voice.ogg");
    });

    it("throws on a provider error so the route refunds the credits", async () => {
        const fetchFn = vi.fn(async () => new Response("bad key", { status: 401 }));
        const cfg = { apiKey: "k", baseUrl: "https://stt.example/v1", model: "m" };
        await expect(transcribeWithProvider(cfg, new Uint8Array(1), "audio/ogg", "a.ogg", fetchFn)).rejects.toThrow(
            /401/,
        );
    });
});
