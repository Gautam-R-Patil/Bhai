// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Standalone Gemini Live test harness — reproduces Bhai's tool-response flow
// and logs every single server message so we can see what Gemini actually
// sends back. Run with:
//
//   npx tsx scripts/test-gemini-live.ts
//
// Requires: Convex session (same env Bhai uses) — ATLAS_OTPLESS_USER_ID set,
// or GOOGLE_API_KEY as env override for direct use.

import "dotenv/config";
import { GoogleGenAI, Modality, FunctionResponseScheduling } from "@google/genai";
import { initSession, getSessionToken } from "../src/session.js";
import { getConvexSiteUrl } from "../src/config/keys.js";

async function fetchGoogleKey(): Promise<string> {
    if (process.env.GOOGLE_API_KEY) {
        console.log("[TEST] Using GOOGLE_API_KEY from env");
        return process.env.GOOGLE_API_KEY;
    }
    console.log("[TEST] No GOOGLE_API_KEY env — fetching from Convex…");
    const ok = await initSession();
    if (!ok) throw new Error("initSession failed — set ATLAS_OTPLESS_USER_ID in .env");
    const token = await getSessionToken();
    if (!token) throw new Error("No session token available");
    const url = `${getConvexSiteUrl()}/api/keys/voice`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Fetch voice keys failed: ${res.status}`);
    const data = (await res.json()) as { googleApiKey?: string };
    if (!data.googleApiKey) throw new Error("No googleApiKey in Convex response");
    console.log("[TEST] Got GOOGLE_API_KEY from Convex");
    return data.googleApiKey;
}

const MODEL = process.env.TEST_MODEL || "gemini-3.1-flash-live-preview";
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 20_000;
const USE_TOOLS = process.env.TEST_TOOLS !== "false";
const USE_TRANSCRIPTIONS = process.env.TEST_TRANSCRIPTIONS !== "false";
const USE_TEMP = process.env.TEST_TEMP !== "false";

// One tool matching Bhai's get_current_time schema shape.
const TOOLS = [
    {
        functionDeclarations: [
            {
                name: "get_current_time",
                description:
                    "Get the current date/time. Always available; use when the user asks for the time.",
                parametersJsonSchema: {
                    type: "object" as const,
                    properties: {
                        timezone: {
                            type: "string",
                            description:
                                "IANA timezone like 'Asia/Kolkata' or 'America/Los_Angeles'. Default: system time.",
                        },
                    },
                    required: [],
                },
            },
        ],
    },
];

interface MsgLog {
    t: number; // ms since start
    keys: string[];
    sc: string[];
    partMimes: string[];
    partTextPreview: string;
    inputTrans: string;
    outputTrans: string;
    turnComplete: boolean;
    generationComplete: boolean;
    interrupted: boolean;
    toolCallIds: string[];
    toolCancelled: string[];
    goAway: boolean;
    usageMetadata: boolean;
    raw200: string;
}

function shapeOf(msg: any): MsgLog {
    // The SDK's onmessage callback receives a LiveServerMessage directly.
    // Some SDK versions wrap in { data }, some don't. Never a string.
    let data: any = msg?.data && typeof msg.data === "object" ? msg.data : msg;
    if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { /* leave as string */ }
    }
    const sc = data?.serverContent;
    const parts: any[] = sc?.modelTurn?.parts || [];
    return {
        t: 0, // filled later
        keys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [`<${typeof data}>`],
        sc: sc ? Object.keys(sc) : [],
        partMimes: parts
            .map((p) => p?.inlineData?.mimeType || (p?.text ? "text" : "other"))
            .filter(Boolean),
        partTextPreview: parts
            .map((p) => p?.text || "")
            .filter(Boolean)
            .join(" | ")
            .slice(0, 200),
        inputTrans: sc?.inputTranscription?.text || "",
        outputTrans: sc?.outputTranscription?.text || "",
        turnComplete: !!sc?.turnComplete,
        generationComplete: !!sc?.generationComplete,
        interrupted: !!sc?.interrupted,
        toolCallIds: (data?.toolCall?.functionCalls || []).map((fc: any) => fc.id || fc.name),
        toolCancelled: data?.toolCallCancellation?.ids || [],
        goAway: !!data?.goAway,
        usageMetadata: !!data?.usageMetadata,
        raw200: JSON.stringify(data).slice(0, 200),
    };
}

async function main() {
    const apiKey = await fetchGoogleKey();
    const ai = new GoogleGenAI({ apiKey });

    const start = Date.now();
    const log: MsgLog[] = [];
    let audioBytes = 0;
    let audioChunks = 0;
    let textChunks = 0;
    let session: any = null;
    let setupSeen = false;
    let toolReplied = false;
    let turnCompleteAfterTool = false;

    console.log(`[TEST] Connecting to ${MODEL}…`);

    const connected = new Promise<void>((resolve, reject) => {
        const hardTimeout = setTimeout(
            () => reject(new Error("connect timeout 15s")),
            15_000,
        );

        const cfg: any = {
            responseModalities: [Modality.AUDIO],
            systemInstruction:
                "You are a friendly voice assistant. When the user asks for the time, call get_current_time and then briefly tell them the answer. Keep all responses to one short sentence.",
        };
        if (USE_TRANSCRIPTIONS) {
            cfg.outputAudioTranscription = {};
            cfg.inputAudioTranscription = {};
        }
        if (USE_TEMP) {
            cfg.temperature = 0.85;
            cfg.maxOutputTokens = 600;
        }
        if (USE_TOOLS) cfg.tools = TOOLS;
        if (process.env.TEST_NOTHINK === "true") {
            cfg.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
        }
        console.log(`[TEST] Config: model=${MODEL} tools=${USE_TOOLS} trans=${USE_TRANSCRIPTIONS} temp=${USE_TEMP}`);

        ai.live
            .connect({
                model: MODEL,
                config: cfg,
                callbacks: {
                    onopen: () => {
                        console.log(`[TEST] WebSocket open (${Date.now() - start}ms)`);
                    },
                    onmessage: (msg: any) => {
                        const m = shapeOf(msg);
                        m.t = Date.now() - start;
                        log.push(m);

                        const data = msg?.data || msg;

                        // Count audio/text parts
                        const parts: any[] = data?.serverContent?.modelTurn?.parts || [];
                        for (const p of parts) {
                            if (p?.inlineData?.data && p.inlineData.mimeType?.startsWith("audio/")) {
                                audioChunks++;
                                audioBytes += Buffer.from(p.inlineData.data, "base64").length;
                            }
                            if (p?.text) textChunks++;
                        }

                        // Summary line
                        const tag =
                            m.keys.includes("setupComplete") ? "SETUP" :
                            m.keys.includes("toolCall") ? "TOOL_CALL" :
                            m.keys.includes("toolCallCancellation") ? "TOOL_CANCEL" :
                            m.keys.includes("goAway") ? "GO_AWAY" :
                            m.partMimes.some((m) => m.startsWith("audio/")) ? "AUDIO" :
                            m.partMimes.includes("text") ? "TEXT" :
                            m.outputTrans ? "OUT_TRANS" :
                            m.inputTrans ? "IN_TRANS" :
                            m.turnComplete ? "TURN_COMPLETE" :
                            m.generationComplete ? "GEN_COMPLETE" :
                            m.interrupted ? "INTERRUPTED" :
                            m.usageMetadata ? "USAGE" :
                            "OTHER";

                        const suffix =
                            tag === "AUDIO" ? `chunk#${audioChunks}` :
                            tag === "TEXT" ? `"${m.partTextPreview.slice(0, 60)}"` :
                            tag === "IN_TRANS" ? `"${m.inputTrans}"` :
                            tag === "OUT_TRANS" ? `"${m.outputTrans}"` :
                            tag === "TOOL_CALL" ? m.toolCallIds.join(",") :
                            tag === "OTHER" ? m.keys.join("+") :
                            "";
                        console.log(`[${String(m.t).padStart(6)}ms] ${tag.padEnd(14)} ${suffix}`);

                        // Watch for setupComplete → send user question
                        if (m.keys.includes("setupComplete") && !setupSeen) {
                            setupSeen = true;
                            console.log(
                                `[${String(m.t).padStart(6)}ms] ACTION         sending "What is the time now?" via sendClientContent`,
                            );
                            session.sendClientContent({
                                turns: [
                                    {
                                        role: "user",
                                        parts: [{ text: "What is the time now?" }],
                                    },
                                ],
                            });
                        }

                        // Watch for toolCall → reply with tool response
                        if (
                            data?.toolCall?.functionCalls &&
                            data.toolCall.functionCalls.length &&
                            !toolReplied
                        ) {
                            toolReplied = true;
                            const fc = data.toolCall.functionCalls[0];
                            const resp = {
                                functionResponses: [
                                    {
                                        id: fc.id,
                                        name: fc.name,
                                        response: {
                                            output: JSON.stringify({
                                                iso: new Date().toISOString(),
                                                human: "4:20 PM",
                                            }),
                                        },
                                        scheduling: FunctionResponseScheduling.INTERRUPT,
                                    },
                                ],
                            };
                            console.log(
                                `[${String(m.t).padStart(6)}ms] ACTION         sendToolResponse for ${fc.name} id=${fc.id} scheduling=INTERRUPT`,
                            );
                            console.log(
                                `[${String(m.t).padStart(6)}ms] PAYLOAD        ${JSON.stringify(resp).slice(0, 300)}`,
                            );
                            session.sendToolResponse(resp);
                        }

                        // After tool reply, watch for any model response
                        if (toolReplied && m.turnComplete) {
                            turnCompleteAfterTool = true;
                        }
                    },
                    onerror: (err: any) => {
                        console.error(
                            `[${Date.now() - start}ms] ERROR         ${err?.error?.message || err?.message || JSON.stringify(err)}`,
                        );
                    },
                    onclose: (ev: any) => {
                        console.log(
                            `[${Date.now() - start}ms] CLOSE         code=${ev?.code} reason=${ev?.reason || "(none)"}`,
                        );
                    },
                },
            })
            .then((s) => {
                session = s;
                clearTimeout(hardTimeout);
                resolve();
            })
            .catch((err) => {
                clearTimeout(hardTimeout);
                reject(err);
            });
    });

    await connected;

    // Wait up to TIMEOUT_MS total, then summarize
    await new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS));

    console.log("\n────────────────────────────────────────");
    console.log("SUMMARY");
    console.log("────────────────────────────────────────");
    console.log(`Total messages:       ${log.length}`);
    console.log(`Audio chunks rxed:    ${audioChunks}  (${audioBytes} bytes)`);
    console.log(`Text chunks rxed:     ${textChunks}`);
    console.log(`Tool call received:   ${toolReplied ? "yes" : "no"}`);
    console.log(`Turn-complete post:   ${turnCompleteAfterTool ? "yes" : "no"}`);
    console.log(`Model:                ${MODEL}`);
    console.log("────────────────────────────────────────\n");

    try {
        session?.close?.();
    } catch { /* */ }
    process.exit(0);
}

main().catch((err) => {
    console.error("[TEST] FATAL:", err);
    process.exit(1);
});
