// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Browser tools must not hand the model a password, card number or one-time code.
// Runs each tool's own page code, as the tool sends it, against a stub page.
import { describe, expect, it, vi } from "vitest";

type Field = Record<string, unknown>;
const field = (id: string, value: string, type = "text", autocomplete = ""): Field => ({
    id,
    value,
    type,
    tagName: "INPUT",
    autocomplete,
    textContent: "",
    // The value attribute: here the page pre-filled every field.
    getAttribute: (a: string) => (a === "autocomplete" ? autocomplete : a === "value" ? value : a === "id" ? id : null),
});
const fields = [
    field("email", "me@example.com", "email"),
    field("pw", "Tr0ub4dor&3x", "password"),
    field("card", "4111111111111111", "text", "cc-number"),
    field("code", "482913", "text", "one-time-code"),
    field("empty-pw", "", "password"),
];
const document = { querySelectorAll: () => fields };

// A page whose evaluate runs code the way the browser would: a string is an expression,
// a function gets its argument.
const page = {
    evaluate: async (code: unknown, arg?: unknown) => {
        (globalThis as { document?: unknown }).document = document;
        try {
            return typeof code === "function"
                ? code(arg)
                : new Function("document", `return (${code as string});`)(document);
        } finally {
            delete (globalThis as { document?: unknown }).document;
        }
    },
};
vi.mock("./browser-backend.js", () => ({
    getActiveBackend: async () => ({ mode: "chrome", getPageProxy: async () => page }),
    getCurrentMode: () => "chrome",
    resetBackend: () => {},
}));

const { browserFormState } = await import("./opencli-tools.js");
const { browserExtract } = await import("./extraction.js");

describe("secret form fields", () => {
    it("browser_form_state runs, and reports secret fields as filled, never their values", async () => {
        const out = JSON.parse(await browserFormState.handler({}));
        expect(out.fields).toEqual({
            email: "me@example.com",
            pw: "[filled, hidden]",
            card: "[filled, hidden]",
            code: "[filled, hidden]",
            "empty-pw": "",
        });
    });

    it("browser_extract of value attributes hides the same fields", async () => {
        const out = await browserExtract.handler({ selector: "input", attribute: "value" });
        expect(out).toContain("me@example.com");
        for (const secret of ["Tr0ub4dor&3x", "4111111111111111", "482913"]) expect(out).not.toContain(secret);
    });
});
