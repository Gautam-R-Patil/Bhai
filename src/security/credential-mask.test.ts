// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai's credential masking: real credentials are masked by structure, and
// prose, identifiers, code and URLs come through byte for byte.
import { describe, expect, it } from "vitest";
import { maskCredentials } from "./credential-mask.js";

// [text, the secret that must not survive]
const CREDENTIALS: Array<[string, string]> = [
    ["Authorization: Bearer FAKEtok3nAbc123xyz rejected", "FAKEtok3nAbc123xyz"],
    ["authorization=Bearer fake-tok-4471 rejected", "fake-tok-4471"],
    ["Authorization: Basic ZmFrZXVzZXI6ZmFrZXBhc3M= rejected", "ZmFrZXVzZXI6ZmFrZXBhc3M="],
    ["Basic dTpw rejected", "dTpw"],
    ["Authorization: 8f2fake9c1d3e7a44 rejected", "8f2fake9c1d3e7a44"],
    ['{"Authorization":"Bearer FAKEjson77token11"}', "FAKEjson77token11"],
    ["Authorization: AWS4-HMAC-SHA256 Credential=FAKEID/20261028/ap-south-1/s3/aws4_request, SignedHeaders=host, Signature=ab12fakesig9876", "ab12fakesig9876"],
    ['Authorization: Digest username="ravi", response = "0f1fakedigest23456789ab"', "0f1fakedigest23456789ab"],
    ["upstream said bearer FAKE1free2text3tok rejected", "FAKE1free2text3tok"],
    ["Cookie: sessionid=FAKEsess4455aa; theme=dark", "FAKEsess4455aa"],
    ['Cookie: sid="FAKEquoted99cookie"; lang=en', "FAKEquoted99cookie"],
    ["Set-Cookie: a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, session=FAKEsess0456def; Path=/", "FAKEsess0456def"],
    ["Cookie: FAKEopaque0cookie123456", "FAKEopaque0cookie123456"],
    ['{"cookie":"__Host-auth=sealed-fake-31"}', "sealed-fake-31"],
    ["headers: { cookie: 'sid=fake-inspect-42' }", "fake-inspect-42"],
    ["password=hunter", "hunter"],
    ['{"password":"required"}', "required"],
    ["PGPASSWORD=pg-fake-v22 psql", "pg-fake-v22"],
    ["client_secret: cs-fake-123", "cs-fake-123"],
    ["userAccessToken=fake-uat-77 set", "fake-uat-77"],
    ["totp_seed: JBSWY3DPEHPK3PXP", "JBSWY3DPEHPK3PXP"],
    ["AZURE_STORAGE_ACCOUNT_KEY=FAKEzz0123456789abcdefABCDEF+/xyz==", "FAKEzz0123456789abcdefABCDEF+/xyz=="],
    ["api_key = 'FAKEkey_9f8e7d6c5b4a'", "FAKEkey_9f8e7d6c5b4a"],
    ["export OPENAI_API_KEY=sk-proj-FAKEabc123def456ghi789", "sk-proj-FAKEabc123def456ghi789"],
    ["token ghp_FAKEaaaaBBBBccccDDDDeeee1234 in the log", "ghp_FAKEaaaaBBBBccccDDDDeeee1234"],
    ["slack xoxb-1234-FAKE-tokenvalue here", "xoxb-1234-FAKE-tokenvalue"],
    ["aws AKIAFAKEFAKEFAKE1234 key", "AKIAFAKEFAKEFAKE1234"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsignature123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsignature123"],
    ["-----BEGIN PRIVATE KEY-----\nFAKEMIIBVQIBADAN\n-----END PRIVATE KEY-----", "FAKEMIIBVQIBADAN"],
];

// Must come through unchanged.
const KEEP = [
    "Please fill in the Basic information section before continuing.",
    "He was the Bearer of bad news.",
    "Password: Required.",
    "password: required",
    "The new password is incorrect.",
    "authorization: missing",
    "cookie: invalid format",
    "form body cookie=accepted&next=/checkout rejected",
    "api_key: missing",
    "accountKey: ACME-123",
    "token=visible-fake-9 secret=shown-fake-8",
    '{"token":"visible-4821","secret":"shown-77","pass":"3/5","pin":"required"}',
    "valid_token: abc123def",
    "hasPassword: true",
    "token_type: bearer",
    "PWD=/Users/ravi/projects",
    "sk-hynix-ddr5-memory-kit-2026 is in stock",
    "step sk-onboarding-step-2026 done",
    "const apiKey = getKey(config);",
    "  password: hashPassword(input.password),",
    "const token = process.env.GITHUB_TOKEN;",
    "https://user:pw-fake@example.com/path?token=abc123def456",
    "connect postgres://app@db:5432/app?sslmode=require&password=db-query-fake",
    "Order 4111-2222 shipped to Basic Lane, Pune",
];

describe("credential masking", () => {
    it("masks every credential form", () => {
        const leaks = CREDENTIALS.filter(([t, secret]) => maskCredentials(t).includes(secret)).map(([t]) => t);
        expect(leaks).toEqual([]);
    });
    it("leaves prose, identifiers, code and URLs byte for byte", () => {
        expect(KEEP.filter((t) => maskCredentials(t) !== t)).toEqual([]);
        expect(maskCredentials("Cookie: a=1, then retry")).toBe("Cookie: [redacted], then retry");
    });
});

describe("credentials never reach the model or the logs", () => {
    it("protect() (LLM payloads, logs, chat history) masks them", async () => {
        const { protect } = await import("./pii-vault.js");
        expect(CREDENTIALS.filter(([t, secret]) => protect(t).includes(secret)).map(([t]) => t)).toEqual([]);
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
