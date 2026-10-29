// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// browser_form_state must not hand the model a password, card number or one-time code.
import { expect, it } from "vitest";
import { GET_FORM_STATE_JS } from "./core.js";

const field = (id: string, value: string, type = "text", autocomplete = "") => ({
    id,
    value,
    type,
    tagName: "INPUT",
    autocomplete,
    getAttribute: (a: string) => (a === "autocomplete" ? autocomplete : null),
});

it("reports secret fields as filled, never their values", () => {
    const fields = [
        field("email", "me@example.com", "email"),
        field("pw", "Tr0ub4dor&3x", "password"),
        field("card", "4111111111111111", "text", "cc-number"),
        field("code", "482913", "text", "one-time-code"),
        field("empty-pw", "", "password"),
    ];
    const document = { querySelectorAll: () => fields };
    const out = new Function("document", `return (${GET_FORM_STATE_JS})()`)(document);
    expect(out).toEqual({
        email: "me@example.com",
        pw: "[filled, hidden]",
        card: "[filled, hidden]",
        code: "[filled, hidden]",
        "empty-pw": "",
    });
});
