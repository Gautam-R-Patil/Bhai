// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Server side of the live-streaming codec: one NDJSON line per frame, each its own
// encrypted envelope bound to the request, its position and whether it is the last.

import { encryptResponse } from "./crypto";

// `ping` is a keepalive: the server sends it after a silent stretch; it carries nothing.
export type FrameKind = "text" | "note" | "tool" | "void_tools" | "reset" | "ping" | "error" | "done";

export type Frame = {
    kind: FrameKind;
    text?: string;
    name?: string;
    error?: string;
    status?: number;
    completion?: unknown;
};

const BUCKET = 256;

export async function encodeFrame(
    frame: Frame,
    seq: number,
    final: boolean,
    reqRid: string,
    sharedKeyBase64: string,
): Promise<string> {
    // Pad to the next 256-byte bucket so ciphertext length leaks only coarse size.
    const base = new TextEncoder().encode(JSON.stringify({ ...frame, pad: "" })).length;
    const pad = "0".repeat((BUCKET - (base % BUCKET)) % BUCKET);
    const env = await encryptResponse(
        JSON.stringify({ ...frame, pad }),
        sharedKeyBase64,
        (ts, rid) => `POST|/api/llm/chat|${ts}|${rid}|${reqRid}|${seq}|${final ? 1 : 0}`,
    );
    return `${JSON.stringify(env)}\n`;
}
