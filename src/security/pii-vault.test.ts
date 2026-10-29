// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { maskKnownValues, protect, protectMessages, REVEAL_TOOLS, reveal, revealArgs, setSecrets } from "./pii-vault.js";

describe("PII vault", () => {
    it("the model sees handles; only typing tools get the value back", () => {
        const [user, tool] = protectMessages([
            { role: "user", content: "My OTP is 739204, type it in" },
            { role: "tool", content: [{ type: "text", text: "Card on file 4111 1111 1111 1111" }, { type: "image_url" }] },
        ]);
        expect(user.content).toBe("My OTP is [OTP_1], type it in");
        expect(JSON.stringify(tool.content)).not.toContain("4111");

        const args = { text: "[OTP_1]", nested: ["code [OTP_1]"] };
        expect(revealArgs(args)).toEqual({ text: "739204", nested: ["code 739204"] });
        expect(args.text).toBe("[OTP_1]"); // the original (logged, kept in history) is untouched
        expect(REVEAL_TOOLS.has("browser_type")).toBe(true);
        expect(REVEAL_TOOLS.has("whatsapp_send")).toBe(false); // a message can't exfiltrate the value
    });

    it("a typed value echoed back bare in a tool result is hidden again", () => {
        protect("OTP: 551902");
        expect(protect('{"success":true,"typed":"551902"}')).toBe('{"success":true,"typed":"[OTP_2]"}');
    });

    it("unknown handles stay as written", () => {
        expect(reveal("[CARD_999]")).toBe("[CARD_999]");
        expect(protect("nothing sensitive here")).toBe("nothing sensitive here");
    });
});

describe("PII vault does not mangle ordinary numbers", () => {
    it("a known OTP is hidden only as a whole value, and error codes aren't OTPs", async () => {
        const { protect } = await import("./pii-vault.js");
        protect("Your verification code: 1000");
        expect(protect("const TIMEOUT_MS = 10000; // port 31000")).toBe("const TIMEOUT_MS = 10000; // port 31000");
        expect(protect('{"typed":"1000"}')).toMatch(/\[OTP_\d+\]/);
        expect(protect("Error 4040 is the error code returned")).toBe("Error 4040 is the error code returned");
        expect(protect("482913 is your OTP")).toMatch(/\[OTP_\d+\] is your OTP/);
    });
});

describe("PII vault masks a known value in its encoded forms", () => {
    it("URL-, form-, base64- and JSON-encoded copies of a card become the handle; short codes stay whole-token", async () => {
        const { protect } = await import("./pii-vault.js");
        const card = "4111 1111 1111 1111";
        const h = /\[CARD_\d+\]/.exec(protect(`card ${card}`))?.[0] as string;
        for (const form of [encodeURIComponent(card), new URLSearchParams({ v: card }).toString().slice(2), Buffer.from(card).toString("base64"), JSON.stringify(card).slice(1, -1)]) {
            expect(protect(`?card=${form}&x=1`)).toBe(`?card=${h}&x=1`);
        }
        protect("Your OTP is 4829");
        expect(protect("order id 148290")).toBe("order id 148290");
    });

    it("masks a saved secret a page echoes back spaced out char-by-char", () => {
        try {
            setSecrets(new Map([["sk-live-3e9a7c1b5d2f", "[APIKEY_1]"]]));
            // the literal form
            expect(maskKnownValues("key: sk-live-3e9a7c1b5d2f end")).toBe("key: [APIKEY_1] end");
            // spread out with spaces (the browser_scan / OCR dodge)
            expect(maskKnownValues("s k - l i v e - 3 e 9 a 7 c 1 b 5 d 2 f")).toContain("[APIKEY_1]");
            expect(maskKnownValues("s k - l i v e - 3 e 9 a 7 c 1 b 5 d 2 f")).not.toMatch(/3 e 9 a/);
            // a short coincidental run is not masked (floor is 8 normalized chars)
            setSecrets(new Map([["abc123", "[X_1]"]]));
            expect(maskKnownValues("a b c 1 2 3 here")).toBe("a b c 1 2 3 here");
        } finally {
            setSecrets(new Map());
        }
    });
});
