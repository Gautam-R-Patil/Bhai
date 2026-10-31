// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Smart DND holds Bhai's own proactive notes, never what the owner asked for (a reminder).
import { expect, it, vi } from "vitest";

const shouldSuppressMessage = vi.fn(async () => true);
vi.mock("../proactive/dnd.js", () => ({ shouldSuppressMessage }));

const { sendOverlayNotification } = await import("./overlay-chat.js");

it("DND is consulted for proactive notes but not for a requested reminder", async () => {
    await sendOverlayNotification("a thought I had about your week");
    expect(shouldSuppressMessage).toHaveBeenCalledTimes(1);

    await sendOverlayNotification("⏰ Reminder: join the call", { requested: true });
    expect(shouldSuppressMessage).toHaveBeenCalledTimes(1);
});
