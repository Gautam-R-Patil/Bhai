// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// protect() memo (ATLAS_NO_PROTECT_CACHE) and the single-pass known-value regex
// in pii-vault.ts. Each test loads a fresh vault.

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshVault(env: Record<string, string> = {}) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import("../pii-vault.js");
}

afterEach(() => vi.unstubAllEnvs());

describe("protect() memo", () => {
    it("a value first seen at iteration N is masked in earlier messages at N+1", async () => {
        const { protectMessages } = await freshVault();
        const echoed = { role: "tool", content: '{"success":true,"typed":"551907"}' };
        expect(protectMessages([echoed])[0].content).toBe(echoed.content); // nothing known yet (and now remembered)
        const told = { role: "user", content: "OTP: 551907" };
        const n = protectMessages([echoed, told]);
        expect(n[1].content).toBe("OTP: [OTP_1]");
        const n1 = protectMessages([echoed, told]);
        expect(n1[0].content).toBe('{"success":true,"typed":"[OTP_1]"}');
        expect(n1[1].content).toBe("OTP: [OTP_1]");
    });

    it("keeps the credential policy apart: the same text with and without it", async () => {
        const { protect } = await freshVault();
        const t = "password=hunter2x";
        expect(protect(t)).toBe("password=[redacted]");
        expect(protect(t, { credentials: false })).toBe(t);
        expect(protect(t)).toBe("password=[redacted]");
    });

    it("is a pure memo: a turn gives the same output with ATLAS_NO_PROTECT_CACHE=true", async () => {
        const turn = [
            "Card on file 4111 1111 1111 1111, OTP: 739204",
            '{"typed":"739204"}',
            "Authorization: Bearer FAKEtok3nAbc123xyz rejected",
            "pay ravi.k@okaxis for the order",
            '{"typed":"739204"}',
            "?card=4111%201111%201111%201111&x=1",
            "Your verification code: 1000",
            "const TIMEOUT_MS = 10000; // port 31000 and 1000",
            "Card on file 4111 1111 1111 1111, OTP: 739204",
        ];
        const run = async (env: Record<string, string>) => {
            const { protect } = await freshVault(env);
            return [...turn, ...turn].map((t, i) => protect(t, { credentials: i % 3 !== 0 }));
        };
        expect(await run({})).toEqual(await run({ ATLAS_NO_PROTECT_CACHE: "true" }));
    });
});

describe("single-pass known-value masking", () => {
    it("an OTP that is part of a stored card: the card text maps to the card, the OTP alone to the OTP", async () => {
        const { protect } = await freshVault();
        const card = /\[CARD_\d+\]/.exec(protect("card 4111111111111111"))?.[0];
        const otp = /\[OTP_\d+\]/.exec(protect("Your OTP is 111111"))?.[0];
        expect(card && otp).toBeTruthy();
        expect(protect('{"typed":"4111111111111111"}')).toBe(`{"typed":"${card}"}`);
        expect(protect('{"typed":"111111"}')).toBe(`{"typed":"${otp}"}`);
        expect(protect("order 1111112 and 9111111")).toBe("order 1111112 and 9111111"); // short: whole tokens only
    });

    it("an issued handle is never masked again; handle-shaped text is not a way past the vault", async () => {
        const { protect } = await freshVault();
        expect(protect("Your OTP is 1")).toBe("Your OTP is 1"); // too short to be an OTP
        expect(protect("Your OTP is 1234")).toBe("Your OTP is [OTP_1]");
        expect(protect("pay with 4111111111111111 now")).toBe("pay with [CARD_1] now");
        expect(protect("see [OTP_1] and [CARD_1] then 1234")).toBe("see [OTP_1] and [CARD_1] then [OTP_1]");
        // Never issued: the digits inside are the value itself.
        expect(protect('{"code":"[OTP_1234]"}')).toBe('{"code":"[OTP_[OTP_1]]"}');
        expect(protect('{"c":"[CARD_4111111111111111]"}')).toBe('{"c":"[CARD_[CARD_1]]"}');
    });

    it("a glued short value doesn't hide a known long value that starts inside it", async () => {
        const { protect } = await freshVault();
        expect(protect("Your OTP is 9041")).toBe("Your OTP is [OTP_1]");
        expect(protect("pay with 4111111111111111 now")).toBe("pay with [CARD_1] now");
        expect(protect("ref x904111111111111111 end")).toBe("ref x90[CARD_1] end");
    });

    it("a short value nested in a longer short value is still masked as a whole token", async () => {
        const { protect } = await freshVault();
        expect(protect('document.cookie = "x=1234"', { credentials: false })).toBe('document.cookie = "[COOKIE_1]"');
        expect(protect("Your OTP is 1234")).toBe("Your OTP is [OTP_1]");
        expect(protect("ax=1234 ")).toBe("ax=[OTP_1] "); // "x=1234" is glued; "1234" alone is a token
    });

    it("eviction takes the dropped value's forms out of the regex", async () => {
        const { protect } = await freshVault();
        protect("Your OTP is 100001");
        expect(protect('{"typed":"100001"}')).toBe('{"typed":"[OTP_1]"}');
        for (let i = 0; i < 500; i++) protect(`Your OTP is ${200000 + i}`);
        expect(protect('{"typed":"100001"}')).toBe('{"typed":"100001"}');
        expect(protect('{"typed":"200499"}')).toBe('{"typed":"[OTP_501]"}');
    });
});
