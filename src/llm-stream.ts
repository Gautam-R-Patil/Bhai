// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Live-streaming frame types (same shape as convex/streamFrames.ts).

export type FrameKind = "text" | "note" | "tool" | "void_tools" | "reset" | "error" | "done";

export type Frame = {
    kind: FrameKind;
    text?: string;
    name?: string;
    error?: string;
    status?: number;
    completion?: unknown;
};
