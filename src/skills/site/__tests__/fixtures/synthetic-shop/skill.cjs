// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Reference Site Skill for the synthetic shop (src/skills/site/__tests__/synthetic-shop.ts).
// A skill is a pure function of (phase, snapshot): it never remembers where it
// was, so it picks up correctly after a reload, a retry or a resume.
const price = (t) => Number((/₹\s*([\d,]+)/.exec(t || "") || [])[1]?.replace(/,/g, "")) || undefined;

exports.step = async (phase, { snapshot: s, input = {}, answer }) => {
    const path = new URL(s.url).pathname;
    const el = (id) => s.elements.find((e) => e.id === id);

    // Interstitials first: whatever phase we're in, get them out of the way.
    if (el("accept")) return { actions: [{ op: "click", target: { sel: "#accept" } }] };

    if (phase === "search") {
        if (path === "/results") {
            const options = s.elements
                .filter((e) => e.dataId)
                .map((e) => ({ id: e.dataId, label: (e.context || e.text).replace(/\s*Add$/, ""), price: price(e.context) }));
            return options.length ? { options } : { fail: { reason: "no_results" } };
        }
        if (path === "/") {
            return {
                actions: [
                    { op: "type", target: { sel: "#q" }, value: String(input.query || "") },
                    { op: "click", target: { sel: "#search" } },
                ],
            };
        }
        return { actions: [{ op: "navigate", value: new URL("/", s.url).href }] };
    }

    if (phase === "select") {
        if (path === "/cart") {
            if (!el("captcha")?.checked) return { actions: [{ op: "click", target: { sel: "#captcha" } }] };
            const line = (/(.+₹\s*[\d,]+)/.exec(s.text) || [])[1] || "your order";
            return { confirm: { summary: line.trim(), amount: price(s.text) || 0, submit: { op: "click", target: { sel: "#checkout", text: "Place order" } } } };
        }
        if (path === "/results") return { actions: [{ op: "click", target: { sel: `[data-id="${input.id}"]` } }] };
        return { fail: { reason: `unexpected page ${path} while selecting` } };
    }

    // after_confirm / resume
    if (path === "/otp") {
        if (answer) {
            return {
                actions: [
                    { op: "type", target: { sel: "#otp" }, value: answer },
                    { op: "click", target: { sel: "#verify" } },
                ],
            };
        }
        return { needsUser: { question: "otp", retry: /wrong code/i.test(s.text) } };
    }
    if (path === "/done") return { done: { summary: (/Order placed #\d+/.exec(s.text) || ["Order placed"])[0] } };
    return { fail: { reason: `unexpected page ${path} after confirm` } };
};
