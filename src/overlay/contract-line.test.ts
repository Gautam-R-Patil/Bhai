// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { overlayProgressMessage } from "./overlay-chat.js";

describe("overlayProgressMessage", () => {
    it("sends the contract line as its own message, verbatim, so progress can't overwrite it", () => {
        expect(
            overlayProgressMessage("[ACK] on it — sending the Oct invoice to Priya on Gmail; done = it shows in Sent"),
        ).toEqual({
            type: "contract",
            text: "on it — sending the Oct invoice to Priya on Gmail; done = it shows in Sent",
        });
    });
    it("keeps everything else a progress update", () => {
        expect(overlayProgressMessage("Searching the web...").type).toBe("progress");
    });
});
