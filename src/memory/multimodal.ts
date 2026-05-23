// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Multimodal Memory ─────────────────────────
// Extract information from images, audio, and documents

import { remember } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface MultimodalItem {
    type: "image" | "audio" | "document" | "video";
    source: string;
    extractedText: string;
    metadata: Record<string, unknown>;
}

// ── Extract & Store ───────────────────────────

export async function processAndStoreMultimodal(
    item: MultimodalItem
): Promise<number | null> {
    const content = [
        `[${item.type.toUpperCase()}] ${item.source}`,
        item.extractedText,
        item.metadata ? `Metadata: ${JSON.stringify(item.metadata)}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    return await remember(content, `multimodal_${item.type}`, item.type, 5);
}

// ── Image Description ─────────────────────────

export async function describeImage(
    imageUrl: string,
    openaiClient: { chat: { completions: { create: (params: Record<string, unknown>) => Promise<Record<string, unknown>> } } }
): Promise<string> {
    try {
        const response = await openaiClient.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Describe this image concisely." },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
            ],
            max_tokens: 300,
        }) as { choices: Array<{ message: { content: string } }> };

        return response.choices[0]?.message?.content || "Unable to describe image.";
    } catch (err) {
        console.error("Image description failed:", err);
        return "Image description unavailable.";
    }
}

// ── Audio Extraction ──────────────────────────

export async function extractFromAudio(
    transcribedText: string,
    source: string
): Promise<number | null> {
    return processAndStoreMultimodal({
        type: "audio",
        source,
        extractedText: transcribedText,
        metadata: { transcribed_at: new Date().toISOString() },
    });
}

// ── Document Extraction ───────────────────────

export async function extractFromDocument(
    text: string,
    filename: string
): Promise<number | null> {
    return processAndStoreMultimodal({
        type: "document",
        source: filename,
        extractedText: text,
        metadata: { filename, extracted_at: new Date().toISOString() },
    });
}
