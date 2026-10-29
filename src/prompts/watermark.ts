// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Prompt Watermarking — Invisible markers to detect self-loop injection.
// Prevents prompt injection via feeding agent outputs back as input.

const WATERMARK_PREFIX = "\u200B\u200C\u200D"; // Zero-width chars
const WATERMARK_SUFFIX = "\u200D\u200C\u200B";

export function embedWatermark(prompt: string, sessionId: string): string {
    const marker = encodeWatermark(sessionId);
    return `${WATERMARK_PREFIX}${marker}${WATERMARK_SUFFIX}${prompt}`;
}

export function detectWatermark(text: string): { hasWatermark: boolean; sessionId: string } {
    const idx = text.indexOf(WATERMARK_PREFIX);
    if (idx < 0) return { hasWatermark: false, sessionId: "" };
    const end = text.indexOf(WATERMARK_SUFFIX, idx + WATERMARK_PREFIX.length);
    if (end < 0) return { hasWatermark: false, sessionId: "" };
    const marker = text.substring(idx + WATERMARK_PREFIX.length, end);
    return { hasWatermark: true, sessionId: decodeWatermark(marker) };
}

export function stripWatermarks(text: string): string {
    return text.replace(/\u200B\u200C\u200D[^\u200D]*\u200D\u200C\u200B/g, "");
}

function encodeWatermark(sessionId: string): string {
    return sessionId.split("").map(c =>
        c.charCodeAt(0) % 2 === 0 ? "\u200B" : "\u200C"
    ).join("");
}

function decodeWatermark(marker: string): string {
    return marker.length > 0 ? `session_${marker.length}` : "";
}
