// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Regression tests for the vault review: each case was a way a saved secret
// could reach the model, or be typed where it shouldn't.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offloadIfLarge } from "../agents/tool-output-offload.js";
import { _resetConsent, noteOwnerMessage } from "./consent.js";
import { protect, reveal, revealArgs } from "./pii-vault.js";
import {
    authorizePayment,
    handleDesktopLine,
    loadVault,
    noteSecretTyped,
    resolveVaultArgs,
    secretTypedIn,
    vaultTargetError,
} from "./vault.js";

const KEY64 = "a3f9c2e81b7d4056f9e2c1a8b3d7e6f04a9c8b2e1d7f3a6c5b4e9d8c7f2a1b0e";
const SHORT_PW = "pass12";
const owner = (url: string) => ({ isOwner: true, pageUrl: async () => url });

const ENTRIES = [
    { id: "gh", label: "GitHub", kind: "login", domains: ["github.com"], username: "octo-dev", password: "Gh-Secret-77!" },
    { id: "short", label: "Old forum", kind: "login", domains: ["forum.example.com"], username: "me1234", password: SHORT_PW },
    { id: "key", label: "Deploy key", kind: "api_key", name: "DEPLOY", value: KEY64, domains: ["platform.example.com"] },
    { id: "uk", label: "UK site", kind: "login", domains: ["co.uk"], username: "ukuser1", password: "Uk-Secret-1!" },
    { id: "pages", label: "Pages", kind: "login", domains: ["github.io"], username: "pguser1", password: "Pg-Secret-1!" },
    { id: "hdfc", label: "HDFC card", kind: "card", holder: "D S", number: "4111 1111 1111 1111", expiry: "12/29", brand: "visa" },
    { id: "gpay", label: "GPay", kind: "upi", vpa: "dheeraj@okhdfcbank" },
];

beforeEach(() => {
    delete process.env.BHAI_NO_VAULT;
    _resetConsent();
    handleDesktopLine(`##BHAI_VAULT##${JSON.stringify(ENTRIES)}`);
});

const authCard = () => authorizePayment("hdfc", 249, "Biryani", "https://pay.example.com/checkout", async () => "737");

describe("the CVV stays hidden until the tool result is protected", () => {
    it("a CVV echoed back by the tool that typed it is still masked", async () => {
        await authCard();
        const r = await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.cvv}}" }, owner("https://pay.example.com"));
        expect(r).toMatchObject({ args: { text: "737" } });
        expect(protect('{"typed":"737"}')).not.toContain("737");
    });
});

describe("formatted card numbers and UPI IDs can't be laundered through PII handles", () => {
    it("reveal() never turns a handle back into a saved card or UPI ID", () => {
        for (const shown of ["4111-1111-1111-1111", "4111 1111 1111 1111", "DHEERAJ@OKHDFCBANK"]) {
            const masked = protect(`pay with ${shown} now`);
            expect(masked).not.toContain(shown);
            expect(reveal(masked)).not.toContain(shown);
            expect(JSON.stringify(revealArgs({ text: masked }))).not.toContain(shown);
        }
    });
});

describe("partial and short secrets are masked too", () => {
    it("a truncated prefix of a long key is masked", () => {
        expect(protect(`{"typed":"${KEY64.slice(0, 50)}"}`)).not.toContain(KEY64.slice(0, 30));
        expect(protect(`value: ${KEY64.slice(0, 30)}`)).not.toContain(KEY64.slice(0, 30));
    });
    it("a short password glued to other text is masked", () => {
        expect(protect(`x${SHORT_PW}`)).not.toContain(SHORT_PW);
    });
});

describe("cards and UPI only in the browser, on the authorized site, once", () => {
    it("refuses a card token in a desktop typing tool even inside the window", async () => {
        await authCard();
        for (const tool of ["os_type", "os_multi_action", "os_computer_action", "win_os_type"]) {
            const r = await resolveVaultArgs(tool, { text: "{{vault:hdfc.number}}" }, owner(""));
            expect(r, tool).toHaveProperty("error");
            expect(JSON.stringify(r)).not.toContain("4111111111111111");
        }
    });
    it("each card field resolves once per authorization", async () => {
        await authCard();
        const at = owner("https://pay.example.com/x");
        expect(await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.number}}" }, at)).toHaveProperty("args");
        expect(await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.number}}" }, at)).toHaveProperty("error");
    });
    it("UPI also resolves once per authorization", async () => {
        await authorizePayment("gpay", 99, "Tea", "https://pay.example.com/x", async () => null);
        const at = owner("https://pay.example.com/x");
        expect(await resolveVaultArgs("browser_type", { text: "{{vault:gpay.vpa}}" }, at)).toHaveProperty("args");
        expect(await resolveVaultArgs("browser_type", { text: "{{vault:gpay.vpa}}" }, at)).toHaveProperty("error");
    });
});

describe("a saved secret is never accepted as a key name or hotkey (finding #2)", () => {
    it("refuses a vault token in the key field even after the owner approves the call", async () => {
        // Old behaviour: with the owner's OK the password was swapped into `key`, then
        // the OS layer lowercased it and echoed it in an "unknown key" error.
        expect(await resolveVaultArgs("os_type", { key: "{{vault:gh.password}}" }, owner(""))).toHaveProperty("error");
        noteOwnerMessage("yes");
        const r = await resolveVaultArgs("os_type", { key: "{{vault:gh.password}}", confirmed: true }, owner(""));
        expect(r).toHaveProperty("error");
        expect(JSON.stringify(r)).not.toContain("Gh-Secret-77!");
    });
    it("refuses a token in os_multi_action actions[].key too", async () => {
        const r = await resolveVaultArgs(
            "os_multi_action",
            { actions: [{ type: "key", key: "{{vault:gh.password}}" }] },
            owner(""),
        );
        expect(r).toHaveProperty("error");
        expect(JSON.stringify(r)).not.toContain("Gh-Secret-77!");
    });
    it("refuses a token in os_computer_action text when the action presses keys", async () => {
        noteOwnerMessage("yes");
        // action:"key" presses `text` as a key; a token there is a key press, not typed text.
        const r = await resolveVaultArgs(
            "os_computer_action",
            { action: "key", text: "{{vault:gh.password}}", confirmed: true },
            owner(""),
        );
        expect(r).toHaveProperty("error");
        expect(JSON.stringify(r)).not.toContain("Gh-Secret-77!");
    });
});

describe("a payment is bound to the approved merchant host (finding #1)", () => {
    it("the card is refused on any origin other than the authorized one", async () => {
        await authCard(); // authorized on pay.example.com
        const r = await resolveVaultArgs(
            "browser_type",
            { text: "{{vault:hdfc.number}}" },
            owner("https://look-alike-pay.example/checkout"),
        );
        expect(r).toHaveProperty("error");
        expect(JSON.stringify(r)).not.toContain("4111");
    });
    it("the CVV prompt is told the merchant host", async () => {
        let promptedSite = "";
        await authorizePayment("hdfc", 249, "Biryani", "pay.example.com", async (_l, _i, _a, site) => {
            promptedSite = site;
            return "737";
        });
        expect(promptedSite).toBe("pay.example.com");
    });
});

describe("a typed CVV stays masked after the authorization ends (finding #4)", () => {
    it("protect() still hides the CVV once the 5-minute window closes", async () => {
        vi.useFakeTimers();
        try {
            await authorizePayment("hdfc", 249, "Biryani", "pay.example.com", async () => "737");
            expect(protect('{"cvv":"737","n":"x"}')).not.toContain("737"); // during the window
            vi.advanceTimersByTime(6 * 60_000); // past AUTH_MS → the authorization expires
            expect(protect('{"cvv":"737"}')).not.toContain("737"); // still masked for the rest of the task
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("public suffixes are not a site", () => {
    it("a login saved for co.uk or github.io never resolves on someone's subdomain", async () => {
        for (const [tok, url] of [
            ["{{vault:uk.password}}", "https://evil.co.uk/login"],
            ["{{vault:pages.password}}", "https://attacker.github.io/"],
        ]) {
            expect(await resolveVaultArgs("browser_type", { text: tok }, owner(url)), url).toHaveProperty("error");
        }
    });
});

describe("site_task never gets a saved secret", () => {
    it("refuses a vault token in site_task", async () => {
        const r = await resolveVaultArgs("site_task", { answer: "{{vault:gh.password}}" }, owner("https://github.com/"));
        expect(r).toHaveProperty("error");
    });
});

describe("desktop consent names the target and covers only that call", () => {
    it("a yes for one place does not allow typing into another", async () => {
        const at = { text: "{{vault:gh.password}}", x: 10, y: 20 };
        const asked = await resolveVaultArgs("os_type", at, owner(""));
        expect(JSON.stringify(asked)).toMatch(/10.*20/); // the question says where
        noteOwnerMessage("yes");
        expect(await resolveVaultArgs("os_type", { ...at, x: 900, confirmed: true }, owner(""))).toHaveProperty("error");
    });
    it("a yes that isn't the owner's very next message doesn't count", async () => {
        const at = { text: "{{vault:gh.password}}" };
        await resolveVaultArgs("os_type", at, owner(""));
        noteOwnerMessage("what is this about?");
        noteOwnerMessage("ok");
        expect(await resolveVaultArgs("os_type", { ...at, confirmed: true }, owner(""))).toHaveProperty("error");
    });
});

describe("the origin is checked where the keystrokes land", () => {
    it("browser resolution returns the rules the typing tool re-checks", async () => {
        const r = await resolveVaultArgs("browser_type", { text: "{{vault:gh.password}}" }, owner("https://github.com/login"));
        if (!("rules" in r)) throw new Error("no rules");
        expect(vaultTargetError(r.rules, "https://github.com/login", "https://github.com/login")).toBeNull();
        expect(vaultTargetError(r.rules, "https://evil.com/", "https://evil.com/")).toMatch(/Refused/);
        // the top page is right, but focus is in a cross-origin frame
        expect(vaultTargetError(r.rules, "https://github.com/login", "https://evil.com/frame")).toMatch(/Refused/);
        expect(vaultTargetError(r.rules, "https://github.com/login", "")).toMatch(/Refused/);
    });
    it("payments are bound to the authorized top page; the card field may sit in a known-PSP frame only", async () => {
        await authCard();
        const r = await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.number}}" }, owner("https://pay.example.com/x"));
        if (!("rules" in r)) throw new Error("no rules");
        // merchant's own frame or a known payment provider (Stripe): allowed
        expect(vaultTargetError(r.rules, "https://pay.example.com/x", "https://pay.example.com/x")).toBeNull();
        expect(vaultTargetError(r.rules, "https://pay.example.com/x", "https://js.stripe.com/f")).toBeNull();
        // a cross-origin ad/widget iframe on the merchant page: refused (finding #3)
        expect(vaultTargetError(r.rules, "https://pay.example.com/x", "https://evil.example/ad")).toMatch(/Refused/);
        expect(vaultTargetError(r.rules, "https://evil.com/", "https://js.stripe.com/f")).toMatch(/Refused/);
        expect(vaultTargetError(r.rules, "https://pay.example.com/x", "http://plain.example/f")).toMatch(/Refused/);
    });
    it("an origin a secret was typed into stays tainted for the rest of the task (survives back/forward)", () => {
        noteSecretTyped("https://github.com");
        expect(secretTypedIn("https://github.com")).toBe(true); // any page on that origin, even a fresh document
        expect(secretTypedIn("https://other.example")).toBe(false); // a different origin is clear
    });
});

describe("large results are masked before they are written to disk", () => {
    it("offloadIfLarge never writes a saved secret", () => {
        const big = JSON.stringify({ page: "x".repeat(20_000), key: KEY64 });
        const r = offloadIfLarge("browser_navigate", "t1", "turn-vault", big);
        expect(r.offloaded).toBe(true);
        expect(r.savedAt && existsSync(r.savedAt)).toBeTruthy();
        expect(readFileSync(r.savedAt as string, "utf8")).not.toContain(KEY64);
        expect(r.content).not.toContain(KEY64);
        rmSync(dirname(r.savedAt as string), { recursive: true, force: true });
    });
});

// keep loadVault referenced for type-only import lint
void loadVault;
