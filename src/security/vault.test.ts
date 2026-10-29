// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requiresConfirmation } from "../tools/tool-intelligence.js";
import { vaultAuthorizePayment, vaultList } from "../tools/vault.js";
import { _resetConsent, noteOwnerMessage } from "./consent.js";
import { maskKnownValues, protect, protectMessages, REVEAL_TOOLS, reveal, revealArgs } from "./pii-vault.js";
import {
    anySecretTyped,
    authorizePayment,
    handleDesktopLine,
    listVault,
    loadVault,
    noteSecretTyped,
    resetVaultTask,
    resolveVaultArgs,
    secretTypedIn,
} from "./vault.js";

const PASSWORD = "Hunter2-zomato!";
const USER = "dheeraj@example.com";
const KEY = "sk-live-9f8e7d6c5b4a3210";
const CARD = "4111 1111 1111 1111";
const owner = (url: string) => ({ isOwner: true, pageUrl: async () => url });

const ENTRIES = [
    {
        id: "zomato",
        label: "Zomato",
        kind: "login",
        domains: ["https://www.zomato.com/login"],
        username: USER,
        password: PASSWORD,
    },
    {
        id: "openai",
        label: "OpenAI key",
        kind: "api_key",
        name: "OPENAI",
        value: KEY,
        domains: ["platform.openai.com"],
    },
    {
        id: "hdfc",
        label: "HDFC card",
        kind: "card",
        holder: "D S",
        number: CARD,
        expiry: "12/29",
        brand: "visa",
        cvv: "321",
    },
    { id: "gpay", label: "GPay", kind: "upi", vpa: "dheeraj@okhdfcbank" },
];

beforeEach(() => {
    delete process.env.ATLAS_NO_VAULT;
    _resetConsent();
    handleDesktopLine(`##BHAI_VAULT##${JSON.stringify(ENTRIES)}`); // the desktop app's stdin line
});
afterEach(() => {
    delete process.env.ATLAS_NO_VAULT;
});

describe("vault: the model sees labels and tokens, never values", () => {
    it("vault_list carries no secret (and no CVV, which is never kept)", async () => {
        const out = await vaultList.handler({});
        for (const secret of [PASSWORD, USER, KEY, CARD, CARD.replace(/ /g, ""), "321", "dheeraj@okhdfcbank"])
            expect(out).not.toContain(secret);
        const rows = JSON.parse(out).entries;
        expect(rows.find((r: { id: string }) => r.id === "zomato")).toMatchObject({
            domains: ["zomato.com"],
            username_masked: "d***@example.com",
        });
        expect(rows.find((r: { id: string }) => r.id === "hdfc").last4).toBe("1111");
        expect(JSON.stringify(listVault("zomato"))).toContain("{{vault:zomato.password}}");
        expect(listVault("zomato")).toHaveLength(1);
    });

    it("vault_list finds an entry by the URL or phrase the model has, not only its label", () => {
        for (const q of [
            "https://www.zomato.com/login",
            "zomato.com/login?next=/",
            "www.zomato.com",
            "log in to Zomato",
        ])
            expect(listVault(q).map((r) => r.id)).toEqual(["zomato"]);
        expect(listVault("netflix.com")).toEqual([]);
    });

    it("a saved value in a tool result or log line comes back as its token", () => {
        expect(protect(`{"typed":"${PASSWORD}"}`)).toBe('{"typed":"{{vault:zomato.password}}"}');
        expect(protect(`Authorization key ${KEY} ok`)).not.toContain(KEY);
        expect(protect(`card ${CARD.replace(/ /g, "")}`)).toContain("{{vault:hdfc.number}}");
        expect(protect(encodeURIComponent(PASSWORD))).toBe("{{vault:zomato.password}}");
        // pii-vault's own reveal() never turns a vault token back into a value
        expect(reveal("{{vault:zomato.password}}")).toBe("{{vault:zomato.password}}");
        expect(revealArgs({ text: "{{vault:zomato.password}}" })).toEqual({ text: "{{vault:zomato.password}}" });
    });
});

describe("vault: tokens resolve only inside typing tools, under the domain lock", () => {
    it("resolves on the entry's site (and its subdomains) and leaves the caller's args alone", async () => {
        const args = { text: "{{vault:zomato.password}}", label: 3 };
        const r = await resolveVaultArgs("browser_type", args, owner("https://www.zomato.com/login"));
        expect(r).toMatchObject({ args: { text: PASSWORD, label: 3 } });
        expect(args.text).toBe("{{vault:zomato.password}}");
        expect(
            await resolveVaultArgs(
                "browser_type",
                { text: "{{vault:zomato.username}}" },
                owner("https://accounts.zomato.com/x"),
            ),
        ).toMatchObject({
            args: { text: USER },
        });
        expect(REVEAL_TOOLS.has("whatsapp_send")).toBe(false); // agent.ts resolves for REVEAL_TOOLS only
    });

    it("refuses a login token on another site, a lookalike, plain http, or for a non-owner", async () => {
        for (const url of [
            "https://evil.com/login",
            "https://zomato.com.evil.com/",
            "https://notzomato.com/",
            "http://www.zomato.com/login",
            "about:blank",
        ]) {
            const r = await resolveVaultArgs("browser_type", { text: "{{vault:zomato.password}}" }, owner(url));
            expect(r, url).toHaveProperty("error");
            expect(JSON.stringify(r)).not.toContain(PASSWORD);
        }
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:openai.apikey}}" }, owner("https://zomato.com/")),
        ).toHaveProperty("error");
        expect(
            await resolveVaultArgs(
                "browser_type",
                { text: "{{vault:zomato.password}}" },
                { isOwner: false, pageUrl: async () => "https://zomato.com" },
            ),
        ).toHaveProperty("error");
        expect(
            await resolveVaultArgs(
                "browser_multi_action",
                { actions: [{ value: "{{vault:zomato.password}}" }] },
                owner("https://zomato.com"),
            ),
        ).toHaveProperty("error");
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:nope.password}}" }, owner("https://zomato.com")),
        ).toHaveProperty("error");
    });

    it("a desktop app (no origin) needs the owner's yes, then the confirmed repeat", async () => {
        const args = { text: "{{vault:zomato.password}}" };
        expect(await resolveVaultArgs("os_type", args, owner(""))).toHaveProperty("error");
        noteOwnerMessage("yes go ahead");
        expect(await resolveVaultArgs("os_type", { ...args, confirmed: true }, owner(""))).toMatchObject({
            args: { text: PASSWORD },
        });
    });

    it("the model only ever handles tokens: resolved args reach the tool, an echo of the value is masked before the LLM", async () => {
        const fnArgs = { text: "{{vault:zomato.password}}" };
        const r = (await resolveVaultArgs("browser_type", fnArgs, owner("https://zomato.com"))) as {
            args: typeof fnArgs;
        };
        expect(JSON.stringify(r.args)).not.toContain("{{vault:"); // nothing un-resolved is typed
        const toolResult = JSON.stringify({ success: true, typed: r.args.text, page: `value=${PASSWORD}` });
        const toLLM = JSON.stringify(
            protectMessages([
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "t1", function: { name: "browser_type", arguments: JSON.stringify(fnArgs) } }],
                },
                { role: "tool", tool_call_id: "t1", content: toolResult },
            ]),
        );
        expect(toLLM).not.toContain(PASSWORD);
        expect(toLLM).toContain("{{vault:zomato.password}}");
    });
});

describe("vault: payments", () => {
    it("card and UPI tokens need an authorization, which goes through the consent gate", async () => {
        expect(
            requiresConfirmation("vault_authorize_payment", { entry_id: "hdfc", item: "Biryani", amount: 249 })
                .needsConfirmation,
        ).toBe(true);
        const r = await resolveVaultArgs(
            "browser_type",
            { text: "{{vault:gpay.vpa}}" },
            owner("https://pay.example.com"),
        );
        expect(JSON.stringify(r)).toMatch(/vault_authorize_payment/);
    });

    it("over the spend cap is refused before the CVV is asked", async () => {
        let asked = false;
        const r = await authorizePayment("hdfc", 999_999, "TV", "https://pay.example.com", async () => {
            asked = true;
            return "123";
        });
        expect(r).toHaveProperty("error");
        expect(asked).toBe(false);
    });

    it("the CVV is asked at pay time, typed once on the authorized site only, and never kept", async () => {
        const auth = await authorizePayment(
            "hdfc",
            249,
            "Biryani",
            "https://pay.example.com/checkout",
            async () => "987",
        );
        expect(auth).toMatchObject({ ok: true, site: "pay.example.com" });
        expect(JSON.stringify(auth)).not.toContain("987");
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.number}}" }, owner("https://evil.com")),
        ).toHaveProperty("error");
        expect(
            await resolveVaultArgs(
                "browser_type",
                { text: "{{vault:hdfc.number}}" },
                owner("https://pay.example.com/x"),
            ),
        ).toMatchObject({
            args: { text: CARD.replace(/ /g, "") },
        });
        expect(protect('{"cvv":"987"}')).toBe('{"cvv":"{{vault:hdfc.cvv}}"}');
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.cvv}}" }, owner("https://pay.example.com")),
        ).toMatchObject({ args: { text: "987" } });
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.cvv}}" }, owner("https://pay.example.com")),
        ).toHaveProperty("error");
        // Still masked after its one use, until the authorization ends (the
        // result of the call that typed it may show it).
        expect(protect("cvv 987")).toBe("cvv {{vault:hdfc.cvv}}");
        // The CVV that came in with the entry was dropped on load.
        loadVault(ENTRIES);
        expect(JSON.stringify(listVault())).not.toContain("321");
        expect(protect("code 321")).toBe("code 321");
    });

    it("no CVV from the owner means no payment", async () => {
        expect(await authorizePayment("hdfc", 100, "Tea", "https://pay.example.com", async () => null)).toHaveProperty(
            "error",
        );
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:hdfc.number}}" }, owner("https://pay.example.com")),
        ).toHaveProperty("error");
    });
});

describe("vault: taint and masks are per-task, not cleared by a mid-task vault edit (finding)", () => {
    const LOGIN = (password: string) => [
        { id: "l", label: "Site", kind: "login", domains: ["legit.test"], username: "u@e.com", password },
    ];

    it("a vault edit/delete keeps the origin tainted (JS + screenshots stay off for the task)", () => {
        loadVault(LOGIN("Old-Password-123!"));
        noteSecretTyped("https://legit.test");
        expect(secretTypedIn("https://legit.test")).toBe(true);
        expect(anySecretTyped()).toBe(true);
        loadVault(LOGIN("New-Password-456!")); // owner fixes a typo / rotates the password mid-task
        expect(secretTypedIn("https://legit.test")).toBe(true);
        expect(anySecretTyped()).toBe(true);
        loadVault([]); // deleted entirely mid-task
        expect(secretTypedIn("https://legit.test")).toBe(true);
    });

    it("the old secret value stays masked after it is edited/deleted out of the vault (page may still hold it)", () => {
        const OLD = "Old-Password-123!";
        loadVault(LOGIN(OLD));
        expect(maskKnownValues(`field value is ${OLD}`)).not.toContain(OLD);
        loadVault(LOGIN("New-Password-456!")); // rotated mid-task
        expect(maskKnownValues(`field value is ${OLD}`)).not.toContain(OLD);
        loadVault([]); // deleted mid-task
        expect(maskKnownValues(`field value is ${OLD}`)).not.toContain(OLD);
    });

    it("a real task boundary clears the taint and drops removed values from the mask", () => {
        const OLD = "Only-This-Task-999!";
        loadVault(LOGIN(OLD));
        noteSecretTyped("https://legit.test");
        loadVault([]); // removed this task
        resetVaultTask(); // next top-level turn
        expect(anySecretTyped()).toBe(false);
        expect(secretTypedIn("https://legit.test")).toBe(false);
        expect(maskKnownValues(`value is ${OLD}`)).toContain(OLD); // not a secret any more
    });
});

describe("vault: kill switch", () => {
    it("ATLAS_NO_VAULT=true turns off resolution and the tools", async () => {
        process.env.ATLAS_NO_VAULT = "true";
        expect(
            await resolveVaultArgs("browser_type", { text: "{{vault:zomato.password}}" }, owner("https://zomato.com")),
        ).toHaveProperty("error");
        expect(JSON.parse(await vaultList.handler({}))).toHaveProperty("error");
        expect(
            JSON.parse(await vaultAuthorizePayment.handler({ entry_id: "hdfc", item: "x", amount: 1 })),
        ).toHaveProperty("error");
        expect(await authorizePayment("hdfc", 1, "x", "https://pay.example.com", async () => "123")).toHaveProperty(
            "error",
        );
    });
});
