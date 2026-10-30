// © 2024-2026 XAGI Labs Private Limited
import { describe, it, expect, vi } from "vitest";
import { createNotify, setDeepResearchNotifier, setOverlayResearchProgress } from "./index.js";

describe("research notifications follow where research was asked", () => {
    it("started on the computer: the computer only, never Telegram", async () => {
        const channels = vi.fn(async () => {});
        const overlay = vi.fn(async () => {});
        setDeepResearchNotifier(channels);
        setOverlayResearchProgress(overlay);
        await createNotify({ channel: "overlay", userId: "local", isOwner: true } as never)("Phase 1");
        expect(overlay).toHaveBeenCalledWith("Phase 1");
        expect(channels).not.toHaveBeenCalled();
    });
    it("started on Telegram: the channels notifier as before", async () => {
        const channels = vi.fn(async () => {});
        setDeepResearchNotifier(channels);
        setOverlayResearchProgress(vi.fn(async () => {}));
        await createNotify({ channel: "telegram", userId: "1", isOwner: true } as never)("Phase 1");
        expect(channels).toHaveBeenCalledWith("Phase 1");
    });
});
