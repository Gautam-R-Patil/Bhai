// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { expect, it, vi } from "vitest";
import { deliverOnFirst } from "./owner-delivery.js";

it("sends on the primary only when it delivers, else on the next that does", async () => {
    const tg = vi.fn(async () => true);
    const wa = vi.fn(async () => true);
    expect(await deliverOnFirst("telegram", { whatsapp: wa, telegram: tg })).toBe("telegram");
    expect(wa).not.toHaveBeenCalled();

    const down = vi.fn(async () => false);
    const throws = vi.fn(async () => {
        throw new Error("offline");
    });
    expect(await deliverOnFirst("telegram", { telegram: down, discord: throws, whatsapp: wa })).toBe("whatsapp");
    expect(await deliverOnFirst("telegram", { telegram: down })).toBeNull();
    expect(await deliverOnFirst("slack", { whatsapp: wa })).toBe("whatsapp"); // primary not connected
});
