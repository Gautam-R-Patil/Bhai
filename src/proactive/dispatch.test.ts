// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The phone/desktop push mirrors what dispatch actually delivered — never past a gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sender, push } = vi.hoisted(() => ({ sender: vi.fn(async () => {}), push: vi.fn(async () => {}) }));
vi.mock("../tools/channel-send.js", () => ({ getChannelSender: () => sender }));
vi.mock("../notifications/push.js", () => ({ getSubscriptionCount: () => 1, sendPushNotification: push }));
vi.mock("../setup/personality-sync.js", () => ({ getToneReminder: () => null }));
const { active } = vi.hoisted(() => ({ active: { value: false } }));
vi.mock("./activity.js", () => ({ isUserActive: async () => active.value }));

const { dispatchProactiveMessage, _setFatigueCheckForTests } = await import("./dispatch.js");
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("proactive push", () => {
    beforeEach(() => {
        sender.mockClear();
        push.mockClear();
        _setFatigueCheckForTests(null);
    });
    afterEach(() => {
        delete process.env.BHAI_PROACTIVE_DISABLE;
        delete process.env.BHAI_PROACTIVE_SHADOW;
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
        process.env.BHAI_PROACTIVE_DISABLE = "true"; // "shut up"
        await dispatchProactiveMessage("overlay", "x", "fyi");
        delete process.env.BHAI_PROACTIVE_DISABLE;
        process.env.BHAI_PROACTIVE_SHADOW = "true";
        await dispatchProactiveMessage("overlay", "x", "fyi");
        delete process.env.BHAI_PROACTIVE_SHADOW;
        _setFatigueCheckForTests(() => true);
        await dispatchProactiveMessage("overlay", "x", "question");
        await flush();
        expect(push).not.toHaveBeenCalled();
    });

    describe("fatigue gate", () => {
        afterEach(() => _setFatigueCheckForTests(null));
        it("holds an ordinary nudge, but never an FYI, a deadline or a reminder the owner asked for", async () => {
            _setFatigueCheckForTests(() => true); // the last two nudges went unanswered
            expect(await dispatchProactiveMessage("telegram", "how'd the call go?", "question")).toBe(false);
            expect(await dispatchProactiveMessage("telegram", "your 5pm moved", "fyi")).toBe(true);
            expect(
                await dispatchProactiveMessage(
                    "telegram",
                    "30m left on the report",
                    "question",
                    undefined,
                    false,
                    true,
                ),
            ).toBe(true);
        });
    });

    describe("while the owner is at the computer", () => {
        let lines: string[];
        beforeEach(() => {
            active.value = true;
            process.env.BHAI_DESKTOP_NOTIFY = "1";
            process.env.PRIMARY_CHANNEL = "telegram";
            lines = [];
            vi.spyOn(process.stdout, "write").mockImplementation((s) => {
                lines.push(String(s));
                return true;
            });
        });
        afterEach(() => {
            active.value = false;
            delete process.env.BHAI_DESKTOP_NOTIFY;
            delete process.env.PRIMARY_CHANNEL;
            _setFatigueCheckForTests(null);
            vi.restoreAllMocks();
        });
        const notes = () => lines.filter((l) => l.startsWith("##BHAI_NOTIFY##"));

        it("a chat-app message also shows on the desktop, a reminder as a reminder", async () => {
            expect(await dispatchProactiveMessage("telegram", "your 5pm moved", "fyi")).toBe(true);
            expect(await dispatchProactiveMessage("whatsapp", "call mom", "fyi", undefined, false, true)).toBe(true);
            expect(sender).toHaveBeenCalledTimes(2);
            expect(notes().map((l) => JSON.parse(l.slice(15)).kind)).toEqual(["proactive", "reminder"]);
        });

        it("a desktop message also goes to the owner's chat channel, once", async () => {
            await dispatchProactiveMessage("overlay", "standup in 10", "fyi");
            expect(sender.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["standup in 10", "💡 standup in 10"]);
        });

        it("nothing is copied when the owner is away, or the send was held back", async () => {
            active.value = false;
            await dispatchProactiveMessage("overlay", "x", "fyi");
            await dispatchProactiveMessage("telegram", "y", "fyi");
            expect(sender).toHaveBeenCalledTimes(2);
            active.value = true;
            _setFatigueCheckForTests(() => true);
            await dispatchProactiveMessage("telegram", "how'd it go?", "question");
            expect(sender).toHaveBeenCalledTimes(2);
            expect(notes()).toHaveLength(0);
        });
    });
});
