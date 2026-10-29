// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

type Box = { x: number; y: number; width: number; height: number };
type Measurable = { boundingBox?: (o?: { timeout?: number }) => Promise<Box | null> };

/**
 * Where a scanned element's centre is NOW, or null when it's gone. The scan's x/y go
 * stale once anything scrolls (scrollIntoViewIfNeeded just may have), so a fallback
 * click must never use them blind: it would land on, or type into, another element.
 */
export async function liveCenter(handle: Measurable | null | undefined): Promise<{ x: number; y: number } | null> {
    const b = await Promise.resolve(handle?.boundingBox?.({ timeout: 500 })).catch(() => null);
    return b && b.width > 0 && b.height > 0 ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}
