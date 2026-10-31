// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// The model's view of the owner's vault (security/vault.ts): labels and tokens,
// never values. vault_authorize_payment goes through the consent gate in
// tools/index.ts (tool-intelligence DESTRUCTIVE_ACTIONS), so its handler only
// runs after the owner said yes to this item and amount.

import { authorizePayment, listVault, vaultEnabled } from "../security/vault.js";
import type { ToolDefinition } from "./get-current-time.js";

const OFF = JSON.stringify({ error: "The vault is turned off (BHAI_NO_VAULT)." });

export const vaultList: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "vault_list",
            description:
                'List the owner\'s saved logins, API keys, cards and UPI IDs (labels only, never the secrets). To log in with a saved account, type its tokens with browser_type, e.g. text "{{vault:<id>.username}}" into the username field and "{{vault:<id>.password}}" into the password field: Bhai fills in the real value on the matching website only. Cards and UPI IDs need vault_authorize_payment first.',
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Optional: a site or label to filter by, e.g. 'zomato'" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        if (!vaultEnabled()) return OFF;
        const entries = listVault(String(input.query ?? ""));
        return JSON.stringify({
            entries,
            ...(entries.length
                ? {}
                : { note: "Nothing saved that matches. The owner can add it in Settings → Vault." }),
        });
    },
};

export const vaultAuthorizePayment: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "vault_authorize_payment",
            description:
                "Before paying with a saved card or UPI ID: call this on the payment page with what is being bought and the total. The owner must approve the item and amount; for a card they type the CVV in a Bhai prompt. Then, for 5 minutes and on this site only, each card/UPI token from vault_list can be typed once with browser_type.",
            parameters: {
                type: "object",
                properties: {
                    entry_id: { type: "string", description: "The card or UPI entry id from vault_list" },
                    item: { type: "string", description: "What is being paid for, as you showed the owner" },
                    amount: { type: "number", description: "The total in INR, as you showed the owner" },
                },
                required: ["entry_id", "item", "amount"],
            },
        },
    },
    async handler(input) {
        if (!vaultEnabled()) return OFF;
        // `site` is the merchant host the consent gate (tools/index.ts) captured from
        // the live tab at approval time and showed the owner. The card binds to THAT
        // host, not whatever tab is live now.
        const r = await authorizePayment(
            String(input.entry_id ?? ""),
            Number(input.amount),
            String(input.item ?? ""),
            String(input.site ?? ""),
        );
        if ("error" in r) return JSON.stringify(r);
        return JSON.stringify({
            authorized: true,
            site: r.site,
            expires_in_seconds: 300,
            tokens: r.tokens,
            next_step:
                "Type each token into its field with browser_type on this site. Each token works once for this payment.",
        });
    },
};
