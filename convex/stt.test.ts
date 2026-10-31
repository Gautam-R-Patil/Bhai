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

describe("server text-to-speech", () => {
    it("is off without a key; Azure is a base URL and a deployment name", async () => {
        const { ttsConfigFromEnv } = await import("./tts");
        expect(ttsConfigFromEnv({})).toBeNull();
        expect(
            ttsConfigFromEnv({
                TTS_API_KEY: "k",
                TTS_BASE_URL: "https://r.openai.azure.com/openai/v1/",
                TTS_MODEL: "my-tts",
            }),
        ).toEqual({ apiKey: "k", baseUrl: "https://r.openai.azure.com/openai/v1", model: "my-tts", voice: "nova" });
    });

    it("asks /audio/speech for Opus and returns the bytes, base64 round-trips", async () => {
        const { encodeBase64, speakWithProvider } = await import("./tts");
        const fetchFn = vi.fn(async () => new Response(new Uint8Array([79, 103, 103, 83]), { status: 200 }));
        const cfg = { apiKey: "k", baseUrl: "https://tts.example/v1", model: "m", voice: "nova" };
        const audio = await speakWithProvider(cfg, "hello", "alloy", fetchFn);
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://tts.example/v1/audio/speech");
        expect(JSON.parse(init.body as string)).toEqual({
            model: "m",
            input: "hello",
            voice: "alloy",
            response_format: "opus",
        });
        expect(Array.from(decodeBase64(encodeBase64(audio)))).toEqual([79, 103, 103, 83]);
        const big = new Uint8Array(100_000).map((_, i) => i % 256);
        expect(decodeBase64(encodeBase64(big))).toEqual(big);
    });

    it("throws with the provider's status on failure", async () => {
        const { speakWithProvider } = await import("./tts");
        const fetchFn = vi.fn(async () => new Response("no deployment", { status: 404 }));
        const cfg = { apiKey: "k", baseUrl: "https://tts.example/v1", model: "m", voice: "nova" };
        await expect(speakWithProvider(cfg, "hi", undefined, fetchFn)).rejects.toThrow(
            "TTS provider 404: no deployment",
        );
    });
});

describe("hearing a recording (audio model)", () => {
    const cfg = { apiKey: "k", baseUrl: "https://a.example/v1", model: "t", audioModel: "gpt-audio-1.5" };
    const answer = (content: string) =>
        vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));

    it("AUDIO_MODEL turns it on", () => {
        expect(sttConfigFromEnv({ STT_API_KEY: "k", AUDIO_MODEL: " gpt-audio-1.5 " })?.audioModel).toBe(
            "gpt-audio-1.5",
        );
        expect(sttConfigFromEnv({ STT_API_KEY: "k" })?.audioModel).toBeUndefined();
    });

    it("sends the audio to the chat model and returns the words and the sounds", async () => {
        const { analyzeWithProvider } = await import("./stt");
        const fetchFn = answer('```json\n{"transcript": "train is late", "sounds": "station announcements"}\n```');
        const heard = await analyzeWithProvider(cfg, decodeBase64(btoa("mp3")), "mp3", fetchFn);
        expect(heard).toEqual({ text: "train is late", sounds: "station announcements" });
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://a.example/v1/chat/completions");
        const body = JSON.parse(init.body as string);
        expect(body.model).toBe("gpt-audio-1.5");
        expect(body.messages[0].content[1]).toEqual({
            type: "input_audio",
            input_audio: { data: btoa("mp3"), format: "mp3" },
        });
    });

    it("keeps a plain-words answer as the transcript", async () => {
        const { analyzeWithProvider } = await import("./stt");
        expect(await analyzeWithProvider(cfg, decodeBase64(btoa("x")), "wav", answer("just words"))).toEqual({
            text: "just words",
            sounds: "",
        });
    });
});

describe("transcription URL", () => {
    it("Azure goes to the deployment; anyone else to /audio/transcriptions", async () => {
        const { transcriptionUrl } = await import("./stt");
        expect(
            transcriptionUrl({
                apiKey: "k",
                baseUrl: "https://bhai-speech-eastus2.openai.azure.com/openai/v1",
                model: "gpt-transcribe",
            }),
        ).toBe(
            "https://bhai-speech-eastus2.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
        );
        expect(transcriptionUrl({ apiKey: "k", baseUrl: "https://api.groq.com/openai/v1", model: "w" })).toBe(
            "https://api.groq.com/openai/v1/audio/transcriptions",
        );
    });
});
