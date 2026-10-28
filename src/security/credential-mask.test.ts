// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pomerado's credential-masking corpus (MIT, vendored): real credentials are
// masked by structure, and prose, identifiers and URLs come through byte for byte.
import { describe, expect, it } from "vitest";
import { credentials, prose, urls } from "./vendor/pomerado-credential-corpus.js";
import { redactDiagnosticText } from "./vendor/pomerado-credential-mask.js";

describe("credential masking (Pomerado corpus)", () => {
    it("masks every diagnostic-surface credential and leaves prose and URLs alone", () => {
        const leaks = credentials.filter(([text, secret, s]) => s.includes("diagnostic") && redactDiagnosticText(text, Number.POSITIVE_INFINITY).includes(secret));
        const changed = [...prose, ...urls].filter((t) => redactDiagnosticText(t, Number.POSITIVE_INFINITY) !== t);
        expect(leaks.map(([t]) => t)).toEqual([]);
        expect(changed).toEqual([]);
    });
});

describe("credentials never reach the model or the logs", () => {
    it("protect() (LLM payloads, logs, chat history) masks what Bhai's sanitizer used to miss", async () => {
        const { protect } = await import("./pii-vault.js");
        const leaks = credentials.filter(([text, secret, s]) => s.includes("diagnostic") && protect(text).includes(secret));
        expect(leaks.map(([t]) => t)).toEqual([]);
        for (const t of [...prose, ...urls]) expect(protect(t)).toBe(t);
    });
});

describe("redact before truncating", () => {
    it("a token cut by truncation never leaks a fragment", async () => {
        const { smartTruncate } = await import("../agents/smart-truncate.js");
        const token = "ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234";
        const out = smartTruncate("default", `${"x".repeat(5000)}\nAuthorization: Bearer ${token}\n${"y".repeat(5000)}`, 5030);
        expect(out).not.toContain(token.slice(0, 12));
    });
});

describe("the credential policy never rewrites code the agent edits", () => {
    it("code-tool results and the owner's own messages pass through; a page's credentials are masked", async () => {
        const { protectMessages } = await import("./pii-vault.js");
        const code = "const apiKey = getKey(config);\n  password: hashPassword(input.password),";
        const page = "Authorization: Basic ZmFrZTpmYWtlcGFzcw==";
        const out = protectMessages([
            { role: "user", content: code },
            { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "read" } }, { id: "b", function: { name: "browser_extract" } }] },
            { role: "tool", tool_call_id: "a", content: code },
            { role: "tool", tool_call_id: "b", content: page },
        ]);
        expect(out[0].content).toBe(code);
        expect(out[2].content).toBe(code);
        expect(out[3].content).not.toContain("ZmFrZTpmYWtlcGFzcw");
    });
});

describe("card detection precision", () => {
    it("timestamps, snowflake IDs and file names are not cards; real cards still are", async () => {
        const { redactPii } = await import("./pii-redactor.js");
        let fp = 0;
        for (let i = 0; i < 200; i++) {
            const ts = 1761234567000 + i;
            const t = `file_${ts}.png at ${ts} and https://x.com/u/status/18${ts}123`;
            if (redactPii(t).text !== t) fp++;
        }
        expect(fp).toBe(0);
        expect(redactPii("Card number: 4111 1111 1111 1111").text).toBe("Card number: [CARD_1]");
        expect(redactPii("use 4111111111111111 for the order").text).toBe("use [CARD_1] for the order");
    });

    it("handle numbers are never reused after old values are dropped", async () => {
        const { redactPii } = await import("./pii-redactor.js");
        const handles = new Map<string, string>();
        redactPii("OTP: 111111", handles);
        handles.clear(); // what the vault's eviction does
        expect(redactPii("OTP: 222222", handles).text).toBe("OTP: [OTP_2]");
    });
});
