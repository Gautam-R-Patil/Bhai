// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The phone/desktop push mirrors what dispatch actually delivered — never past a gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sender, push } = vi.hoisted(() => ({ sender: vi.fn(async () => {}), push: vi.fn(async () => {}) }));
vi.mock("../tools/channel-send.js", () => ({ getChannelSender: () => sender }));
vi.mock("../notifications/push.js", () => ({ getSubscriptionCount: () => 1, sendPushNotification: push }));
vi.mock("../setup/personality-sync.js", () => ({ getToneReminder: () => null }));

const { dispatchProactiveMessage, _setFatigueCheckForTests } = await import("./dispatch.js");
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("proactive push", () => {
    beforeEach(() => {
        sender.mockClear();
        push.mockClear();
        _setFatigueCheckForTests(null);
    });
    afterEach(() => {
        delete process.env.ATLAS_PROACTIVE_DISABLE;
        delete process.env.ATLAS_PROACTIVE_SHADOW;
    });

    it("an overlay delivery is pushed once, as composed", async () => {
        await dispatchProactiveMessage("overlay", "Your 5pm with Priya moved to 6.", "fyi");
        await flush();
        expect(sender).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith("Bhai", "Your 5pm with Priya moved to 6.");
    });

    it("a chat-channel delivery doesn't also push", async () => {
        await dispatchProactiveMessage("telegram", "hey", "fyi");
        await flush();
        expect(push).not.toHaveBeenCalled();
    });

    it("nothing is pushed when proactive is off, shadowed or fatigued", async () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true"; // "shut up"
        await dispatchProactiveMessage("overlay", "x", "fyi");
        delete process.env.ATLAS_PROACTIVE_DISABLE;
        process.env.ATLAS_PROACTIVE_SHADOW = "true";
        await dispatchProactiveMessage("overlay", "x", "fyi");
        delete process.env.ATLAS_PROACTIVE_SHADOW;
        _setFatigueCheckForTests(() => true);
        await dispatchProactiveMessage("overlay", "x", "fyi");
        await flush();
        expect(push).not.toHaveBeenCalled();
    });
});
