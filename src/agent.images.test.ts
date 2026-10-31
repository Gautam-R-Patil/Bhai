// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Which inbound images become generate_image's "attached" photo: never Bhai's own screenshots,
// never a guest's in place of the owner's; and HEIC-like formats reach the model as JPEG.
import sharp from "sharp";
import { expect, it, vi } from "vitest";

vi.mock("./account-guard.js", async (orig) => ({
    ...(await orig<typeof import("./account-guard.js")>()),
    checkAccountStatus: async () => ({ allowed: true }),
}));

import { runAgent } from "./agent.js";
import type { LLMClient } from "./llm.js";
import { conversationKey, lastInboundImages } from "./media/image-memory.js";

const sent: string[] = [];
const llm = {
    chat: async ({ messages }: { messages: Array<{ content: unknown }> }) => {
        for (const m of messages)
            if (Array.isArray(m.content))
                for (const p of m.content) if (p?.image_url?.url) sent.push(String(p.image_url.url).slice(0, 30));
        return { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    },
} as unknown as LLMClient;
const photo = (base64: string, extra: object = {}) => [{ type: "image" as const, base64, mimeType: "image/png", ...extra }];
const run = (media: ReturnType<typeof photo>, isOwner: boolean) =>
    runAgent(llm, "nice", undefined, media, undefined, isOwner ? undefined : [], undefined, undefined, {
        channel: "overlay",
        userId: "local",
        isOwner,
    });
const key = conversationKey("overlay", "local");

it("a screenshot Bhai took is never remembered as the owner's photo", async () => {
    await run(photo("U0NSRUVO", { capture: true }), true);
    expect(lastInboundImages(key)).toEqual([]);
}, 60_000);

it("a guest's photo doesn't replace the owner's", async () => {
    await run(photo("T1dORVI="), true);
    await run(photo("R1VFU1Q="), false);
    expect(lastInboundImages(key)).toEqual([{ base64: "T1dORVI=", mimeType: "image/png" }]);
    expect(lastInboundImages(conversationKey("overlay", "guest:local"))).toEqual([]); // no generate_image, nothing kept
}, 60_000);

it("a format Claude can't read reaches it as JPEG", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    sent.length = 0;
    await run([{ type: "image", base64: png.toString("base64"), mimeType: "image/heic" }], true);
    expect(sent.some((u) => u.startsWith("data:image/jpeg;base64,"))).toBe(true);
    expect(sent.some((u) => u.startsWith("data:image/heic"))).toBe(false);
}, 60_000);
