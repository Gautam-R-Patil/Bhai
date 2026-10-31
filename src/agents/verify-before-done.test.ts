// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { anySecretTyped, noteSecretTyped, resetVaultTask } from "../security/vault.js";
import { setActiveChannel } from "../tools/channel-send.js";
import {
    buildVerifyReminder,
    isMutator,
    drivesScreen,
    isVerifier,
    newVerifyGateState,
    pickReceipt,
    recordBatch,
    recordToolCall,
    shouldForceVerify,
} from "./verify-before-done.js";

describe("isVerifier", () => {
    it("counts os_visual_verify only with something the tool can check", () => {
        expect(isVerifier("os_visual_verify", { expect_text: "Saved" })).toBe(true);
        expect(isVerifier("os_visual_verify", { expect_gone: "Sending…" })).toBe(true);
        expect(isVerifier("os_visual_verify", { expected_text: "Saved" })).toBe(true); // alias the tool accepts
        expect(isVerifier("os_visual_verify", { expected_element: "Save button" })).toBe(false); // the tool can't check this
        expect(isVerifier("os_visual_verify", {})).toBe(false);
    });

    it("a look after the last action covers it; an action after a check needs a new one", () => {
        const g = newVerifyGateState();
        recordToolCall(g, "os_type", { text: "128*46" });
        recordToolCall(g, "os_screenshot", {});
        expect(shouldForceVerify(g)).toBe(false);
        recordToolCall(g, "os_smart_click", { instruction: "Send" });
        expect(shouldForceVerify(g)).toBe(true);
        recordToolCall(g, "os_screenshot", {}, true); // failed capture doesn't count
        expect(shouldForceVerify(g)).toBe(true);
    });
});

describe("pickReceipt", () => {
    it("no receipt when only the gridded model image exists (no clean copy could be made)", () => {
        const g = newVerifyGateState();
        recordToolCall(g, "os_smart_click", { label: "Send" }, false, {});
        recordToolCall(g, "os_screenshot", {}, false, { imageUrl: "data:image/jpeg;base64,AAAA" });
        expect(pickReceipt(g, { stuck: false, isOwner: true, isPrivate: true })).toBeUndefined();
    });
    const shot = "data:image/jpeg;base64,QUJD";
    const owner = { isOwner: true, isPrivate: true };
    const turn = (calls: Array<[string, Record<string, unknown>, string?]>) => {
        const g = newVerifyGateState();
        for (const [name, args, imageUrl] of calls) recordToolCall(g, name, args, false, { imageUrl, receiptUrl: imageUrl });
        return g;
    };

    it("a screenshot after the last action is the receipt", () => {
        const g = turn([["os_smart_click", { instruction: "Send" }], ["os_screenshot", {}, shot]]);
        expect(pickReceipt(g, owner)).toEqual({ mimeType: "image/jpeg", imageBase64: "QUJD" });
    });

    it("a screenshot before the last action is not", () => {
        expect(pickReceipt(turn([["os_screenshot", {}, shot], ["os_type", { text: "hi" }]]), owner)).toBeUndefined();
        expect(pickReceipt(turn([["os_screenshot", {}, shot]]), owner)).toBeUndefined(); // nothing was done
    });

    it("none once the agent already sent the screen itself", () => {
        for (const [sender, args] of [
            ["send_screenshot", {}],
            ["send_file", { file_path: "/tmp/screen.PNG" }],
        ] as const) {
            const g = turn([["os_smart_click", { instruction: "Play" }], ["os_screenshot", {}, shot], [sender, args]]);
            expect(pickReceipt(g, owner)).toBeUndefined();
        }
        // A PDF or a song sent along isn't the screen: the receipt stays.
        for (const file_path of ["/tmp/invoice.pdf", "/tmp/song.mp3"]) {
            const g = turn([["os_smart_click", { instruction: "Play" }], ["os_screenshot", {}, shot], ["send_file", { file_path }]]);
            expect(pickReceipt(g, owner)).toBeDefined();
        }
        // Nor a look after the send: it's the same screen. The next action brings the receipt back.
        const sent = turn([["os_click", { x: 1, y: 2 }], ["send_screenshot", {}], ["os_screenshot", {}, shot]]);
        expect(pickReceipt(sent, owner)).toBeUndefined();
        recordToolCall(sent, "os_type", { text: "hi" });
        recordToolCall(sent, "os_screenshot", {}, false, { imageUrl: shot, receiptUrl: shot });
        expect(pickReceipt(sent, owner)).toBeDefined();
        // Nor an image already sent along with a message in this chat; a PDF there leaves the receipt.
        setActiveChannel("whatsapp");
        const send = (sender: string, args: Record<string, unknown>) =>
            turn([["os_click", { x: 1, y: 2 }], ["os_screenshot", {}, shot], [sender, { message: "done", ...args }]]);
        expect(pickReceipt(send("send_message_on_channel", { channel: "whatsapp", file_path: "/tmp/screen.png" }), owner)).toBeUndefined();
        expect(pickReceipt(send("send_message_on_channel", { channel: "whatsapp", file_path: "/tmp/report.pdf" }), owner)).toBeDefined();
        // An image sent to another channel, or WhatsApp'd to a contact, never reached this chat: the receipt stays.
        expect(pickReceipt(send("send_message_on_channel", { channel: "telegram", file_path: "/tmp/screen.png" }), owner)).toBeDefined();
        expect(pickReceipt(send("whatsapp_send", { to: "Mom", file_path: "/tmp/cat.jpg" }), owner)).toBeDefined();
        // send_screenshot / send_file go to Telegram: on a WhatsApp turn they never reached this chat.
        expect(pickReceipt(send("send_screenshot", {}), owner)).toBeDefined();
        expect(pickReceipt(send("send_file", { file_path: "/tmp/screen.png" }), owner)).toBeDefined();
        setActiveChannel(null);
        // A failed send leaves the receipt in place.
        const g = turn([["os_smart_click", { instruction: "Play" }], ["os_screenshot", {}, shot]]);
        recordToolCall(g, "send_screenshot", {}, true);
        expect(pickReceipt(g, owner)).toBeDefined();
    });

    it("a browser screenshot run alongside a screen action is not", () => {
        const g = newVerifyGateState();
        recordBatch(g, [
            { fnName: "os_smart_click", fnArgs: { instruction: "Send" }, isError: false, isBrowser: false },
            { fnName: "browser_scan", fnArgs: { visual: true }, isError: false, isBrowser: true, imageUrl: shot, receiptUrl: shot },
        ]);
        expect(pickReceipt(g, owner)).toBeUndefined();
        // A screen screenshot in the batch after the action still counts.
        recordBatch(g, [{ fnName: "os_screenshot", isError: false, isBrowser: false, imageUrl: shot, receiptUrl: shot }]);
        expect(pickReceipt(g, owner)).toBeDefined();
    });

    it("never in a group, for a contact, or on a stuck turn", () => {
        const g = turn([["os_smart_click", { instruction: "Send" }], ["os_screenshot", {}, shot]]);
        expect(pickReceipt(g, { isOwner: true, isPrivate: false })).toBeUndefined();
        expect(pickReceipt(g, { isOwner: false, isPrivate: true })).toBeUndefined();
        expect(pickReceipt(g, { ...owner, stuck: true })).toBeUndefined();
    });

    it("none when the last action failed", () => {
        const g = newVerifyGateState();
        recordToolCall(g, "os_smart_click", { instruction: "Send" }, false, { failed: true });
        recordToolCall(g, "os_screenshot", {}, false, { imageUrl: shot, receiptUrl: shot });
        expect(pickReceipt(g, owner)).toBeUndefined();
        // A later action that worked brings it back.
        recordToolCall(g, "os_type", { text: "hi" });
        recordToolCall(g, "os_screenshot", {}, false, { imageUrl: shot, receiptUrl: shot });
        expect(pickReceipt(g, owner)).toBeDefined();
    });

    it("none for a turn that touched the vault, even after a concurrent turn resets the vault", () => {
        const g = newVerifyGateState();
        noteSecretTyped("https://bank.example");
        recordBatch(g, [{ fnName: "browser_type", fnArgs: { text: "{{vault:b.password}}" }, isError: false, isBrowser: true, secret: true }]);
        // This turn's own screenshot was withheld; a later one came after another turn's resetVaultTask.
        recordBatch(g, [{ fnName: "os_screenshot", isError: false, isBrowser: false, secret: true }]);
        resetVaultTask();
        expect(anySecretTyped()).toBe(false);
        recordBatch(g, [{ fnName: "os_screenshot", isError: false, isBrowser: false, imageUrl: shot, receiptUrl: shot }]);
        expect(pickReceipt(g, owner)).toBeUndefined();
    });

    it("a later step on the screen, or a delegated agent, makes the screenshot stale", () => {
        for (const [name, args] of [
            ["apple_script", { script: 'tell application "Mail" to send outgoing message 1' }],
            ["app_manager", { action: "quit", app: "Mail" }],
            ["window_manage", { action: "minimize" }],
            ["swarm_task", { task: "finish it" }],
        ] as const) {
            const g = turn([["os_type", { text: "hi" }], ["os_screenshot", {}, shot], [name, args]]);
            expect(pickReceipt(g, owner)).toBeUndefined();
            expect(g.osStateMutated).toBe(true); // still the same action to verify, not a new one
        }
    });

    it("records a batch in the order its lanes ran", () => {
        // send_screenshot reads the screen, so it runs in call order, after the click.
        expect(drivesScreen("send_screenshot")).toBe(true);
        expect(drivesScreen("powershell_script", { script: "keystroke" })).toBe(true);
        expect(drivesScreen("send_file", { file_path: "/tmp/a.png" })).toBe(false);
        // A file sent in the parallel lane started before the click: the later look is the receipt.
        const g = newVerifyGateState();
        recordBatch(g, [
            { fnName: "os_click", fnArgs: { x: 1, y: 2 }, isError: false, isBrowser: false },
            { fnName: "send_file", fnArgs: { file_path: "/tmp/before.png" }, isError: false, isBrowser: false },
        ]);
        recordBatch(g, [{ fnName: "os_screenshot", isError: false, isBrowser: false, imageUrl: shot, receiptUrl: shot }]);
        expect(pickReceipt(g, owner)).toBeDefined();
    });

describe("browser_form_state", () => {
    it("is a check of typed fields, not an action that needs one", () => {
        const state = newVerifyGateState();
        recordToolCall(state, "browser_type", { text: "hi" });
        recordToolCall(state, "browser_form_state", {});
        expect(state.verifyCalled).toBe(true);
        const fresh = newVerifyGateState();
        recordToolCall(fresh, "browser_form_state", {});
        expect(fresh.osStateMutated).toBe(false);
    });
});
});

describe("iMessage sends need a look before 'sent'", () => {
    it("messages_tool send is a mutator; reading isn't", () => {
        expect(isMutator("messages_tool", { action: "send", to: "+911234567890", text: "hi" })).toBe(true);
        expect(isMutator("messages_tool", { action: "read_recent" })).toBe(false);
    });
});

describe("the verify reminder names a check the turn has", () => {
    it("browser actions get browser checks, desktop actions os_visual_verify", () => {
        const state = newVerifyGateState();
        recordToolCall(state, "browser_type", { text: "x" });
        expect(buildVerifyReminder(state)).toContain("browser_form_state");
        expect(buildVerifyReminder(state)).not.toContain("os_visual_verify");
        recordToolCall(state, "os_click", {});
        expect(buildVerifyReminder(state)).toContain("os_visual_verify");
        recordToolCall(state, "win_os_click", {});
        expect(buildVerifyReminder(state)).toContain("win_os_visual_verify");
    });
});
