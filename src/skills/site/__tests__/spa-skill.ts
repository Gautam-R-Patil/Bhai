// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The SPA skill for the synthetic shop (spa: true), shared by the E2E tests
// (spa-primitives, global-stop). Not a test file: importing it registers nothing.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The reference flow for the shop, written for an SPA: results are known by
// what the page shows, not by its URL. `withExpect` adds the outcome waits.
export const skillSource = (withExpect: boolean) => `
const exp = (o) => (${withExpect} ? o : {});
exports.step = (phase, { snapshot: s, input = {} }, lib) => {
    const path = lib.path(s.url);
    const el = (id) => s.elements.find((e) => e.id === id);
    if (el("accept")) return { actions: [{ op: "click", target: { sel: "#accept" } }] };
    const cards = s.elements.filter((e) => e.dataId);
    const soldOut = (e) => /sold out/i.test(e.text);
    const label = (e) => (e.context || e.text).replace(/\\s*(Add|Sold out)$/, "");
    if (phase === "search") {
        if (cards.length) return { options: cards.filter((e) => !soldOut(e)).map((e) => ({ id: e.dataId, label: label(e), price: lib.price(e.context) })) };
        if (/No results/.test(s.text)) return { fail: { reason: "input_rejected: no results", kind: "input_rejected" } };
        if (path !== "/") return { actions: [{ op: "navigate", value: new URL("/", s.url).href }] };
        const actions = [];
        if (input.location && !/Delivering to/.test(s.text)) actions.push(
            { op: "type", target: { sel: "#loc" }, value: input.location },
            { op: "pick", target: { sel: "#loc-list [role=option]" }, value: input.location, field: "location" });
        actions.push(
            { op: "type", target: { sel: "#q" }, value: String(input.query || "") },
            { op: "click", target: { sel: "#search" }, ...exp({ expect: { results: { sel: "[data-item]" }, empty: { text: "No results" } } }) });
        return { actions };
    }
    if (phase === "select") {
        if (path === "/cart") {
            if (!el("captcha")?.checked) return { actions: [{ op: "click", target: { sel: "#captcha" } }] };
            // The line's own elements, never the first ₹ on the page (a banner or a name can carry one).
            const tid = (t) => s.elements.find((e) => e.testid === t);
            const line = tid("cart-line")?.text || "your order";
            const submit = { op: "click", target: { sel: "#checkout", text: "Place order" },
                ...exp({ expect: { placed: { url: "/(done|otp)" }, turned_down: { sel: "[role=alert]" } } }) };
            return { confirm: { summary: line.trim(), amount: lib.price(tid("total")?.text) || 0, submit } };
        }
        const card = cards.find((e) => e.dataId === input.id);
        if (card && soldOut(card)) return { refused: { field: "id", available: cards.filter((e) => !soldOut(e)).map(label) } };
        if (card) return { actions: [{ op: "click", target: { sel: '[data-id="' + input.id + '"]' } }] };
        return { fail: { reason: "unexpected page " + path + " while selecting", kind: "unexpected_page" } };
    }
    if (path === "/done") return { done: { summary: (/Order placed #\\d+/.exec(s.text) || ["Order placed"])[0] } };
    return { fail: { reason: "unexpected page " + path + " after confirm", kind: "unexpected_page" } };
};`;
export const install = (withExpect: boolean, source = skillSource(withExpect)) => {
    const d = mkdtempSync(path.join(tmpdir(), "spa-skill-"));
    const submit = { op: "click", target: { sel: "#checkout", text: "Place order" } };
    writeFileSync(
        path.join(d, "skill.json"),
        JSON.stringify({ name: "spa-shop", domains: ["shop.test"], commits: [submit], questions: [] }),
    );
    writeFileSync(path.join(d, "skill.cjs"), source);
    return path.join(d, "skill.cjs");
};
