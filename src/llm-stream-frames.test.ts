// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { beforeAll, describe, expect, it } from "vitest";
import { decryptFrame, deriveSharedKey, generateKeyPair } from "./crypto-transport.js";
import type { Frame, FrameKind } from "./llm-stream.js";

// The Convex modules live outside tsc's rootDir (src), so load them by a non-literal path.
const CONVEX = "../convex/";
const convexCrypto = (await import(/* @vite-ignore */ `${CONVEX}crypto`)) as {
    generateServerKeyPair(): Promise<{ publicKey: string; privateKey: string }>;
    deriveSharedKey(priv: string, clientPub: string, version: number, serverPub: string): Promise<string>;
};
const { encodeFrame } = (await import(/* @vite-ignore */ `${CONVEX}streamFrames`)) as {
    encodeFrame(f: Frame, seq: number, final: boolean, rid: string, key: string): Promise<string>;
};

let serverKey: string;
const RID = "req-1";

beforeAll(async () => {
    // Real handshake so server and client derive the same key.
    const clientPub = generateKeyPair();
    const server = await convexCrypto.generateServerKeyPair();
    serverKey = await convexCrypto.deriveSharedKey(server.privateKey, clientPub, 2, server.publicKey);
    deriveSharedKey(server.publicKey);
});

describe("stream frame codec", () => {
    const frames: Frame[] = [
        { kind: "text", text: "héllo 👋" },
        { kind: "note", text: "thinking" },
        { kind: "tool", name: "web_search" },
        { kind: "void_tools" },
        { kind: "reset" },
        { kind: "error", error: "boom", status: 502 },
        { kind: "done", completion: { id: "x", choices: [] } },
    ];
    for (const f of frames) {
        it(`round-trips ${f.kind as FrameKind}`, async () => {
            const line = await encodeFrame(f, 0, false, RID, serverKey);
            expect(line.endsWith("\n")).toBe(true);
            const out = decryptFrame(line, RID, 0);
            expect(out.frame).toEqual(f);
            expect(out.final).toBe(false);
        });
    }

    it("marks the final frame", async () => {
        const line = await encodeFrame({ kind: "done" }, 3, true, RID, serverKey);
        expect(decryptFrame(line, RID, 3).final).toBe(true);
    });

    it("rejects a reordered frame", async () => {
        const line = await encodeFrame({ kind: "text", text: "a" }, 1, false, RID, serverKey);
        expect(() => decryptFrame(line, RID, 0)).toThrow();
    });

    it("rejects a frame from another request", async () => {
        const line = await encodeFrame({ kind: "text", text: "a" }, 0, false, RID, serverKey);
        expect(() => decryptFrame(line, "req-2", 0)).toThrow();
    });

    it("pads to 256-byte buckets", async () => {
        const a = JSON.parse(await encodeFrame({ kind: "text", text: "a" }, 0, false, RID, serverKey));
        const b = JSON.parse(await encodeFrame({ kind: "text", text: "ab" }, 0, false, RID, serverKey));
        expect(a.ct.length).toBe(b.ct.length);
    });
});
