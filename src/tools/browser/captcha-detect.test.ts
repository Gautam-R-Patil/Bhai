// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// The detector runs in the page; here it runs against a tiny fake DOM.
// - A visible v2 checkbox is v2 even when v3 (or api.js?render=explicit) is loaded.
// - quickCaptchaCheck (the navigate/click hint and the site_task guard) ignores
//   invisible v3 and widgets whose response token is already filled (ticked).

import { describe, expect, it, vi } from "vitest";

vi.mock("./core.js", () => ({ ATLAS_HUD_JS: "", getActivePage: vi.fn(), touchBrowserActivity: vi.fn() }));
vi.mock("./chrome-bridge.js", () => ({ getActiveExtensionTab: vi.fn(), sendBridgeCommand: vi.fn() }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "playwright" }));
vi.mock("../../voice/transcribe.js", () => ({ transcribeBuffer: vi.fn() }));

const { detectCaptcha, quickCaptchaCheck } = await import("./captcha.js");

type El = { tag: string; attrs: Record<string, string>; value?: string };

// Matches the simple selectors the detector uses: tag, .class, [a], [a="v"], [a*="v"].
function matches(el: El, sel: string): boolean {
    const m = sel.trim().match(/^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
    if (!m) throw new Error(`fake DOM can't parse ${sel}`);
    const [, tag, classes, attrs] = m;
    if (tag && el.tag !== tag) return false;
    const cls = (el.attrs.class ?? "").split(/\s+/);
    for (const c of classes.split(".").filter(Boolean)) if (!cls.includes(c)) return false;
    for (const [, name, op, val] of attrs.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
        const v = el.attrs[name];
        if (v === undefined) return false;
        if (op === "=" && v !== val) return false;
        if (op === "*=" && !v.includes(val)) return false;
    }
    return true;
}

function fakePage(els: El[]) {
    const wrap = (el: El) => ({
        tagName: el.tag.toUpperCase(),
        getAttribute: (n: string) => el.attrs[n] ?? null,
        get value() {
            return el.value ?? "";
        },
        dataset: Object.fromEntries(
            Object.entries(el.attrs)
                .filter(([k]) => k.startsWith("data-"))
                .map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v]),
        ),
    });
    const all = (sel: string) => els.filter((e) => sel.split(",").some((s) => matches(e, s))).map(wrap);
    const document = {
        querySelectorAll: all,
        querySelector: (sel: string) => all(sel)[0] ?? null,
        scripts: els.filter((e) => e.tag === "script").map((e) => ({ src: e.attrs.src ?? "" })),
    };
    return {
        evaluate: async (fn: unknown) => {
            const g = globalThis as Record<string, unknown>;
            g.document = document;
            try {
                return typeof fn === "function" ? fn() : new Function(`return (${fn})`)();
            } finally {
                delete g.document;
            }
        },
    };
}

const V3_SCRIPT: El = { tag: "script", attrs: { src: "https://www.google.com/recaptcha/api.js?render=SITEKEY" } };
const V3_BADGE: El = {
    tag: "iframe",
    attrs: { src: "https://www.google.com/recaptcha/api2/anchor?k=SITEKEY&size=invisible" },
};
const V2_BOX: El = { tag: "iframe", attrs: { src: "https://www.google.com/recaptcha/api2/anchor?k=K2&size=normal" } };
const V2_DIV: El = { tag: "div", attrs: { class: "g-recaptcha", "data-sitekey": "K2" } };
const token = (name: string, value: string, tag = "textarea"): El => ({ tag, attrs: { name }, value });

describe("detectCaptcha", () => {
    it("reads a visible v2 checkbox as v2 even when v3 is loaded on the page", async () => {
        const info = await detectCaptcha(fakePage([V3_SCRIPT, V3_BADGE, V2_DIV, V2_BOX]) as never);
        expect(info).toEqual({ type: "recaptcha-v2", siteKey: "K2" });
    });

    it("does not read api.js?render=explicit as v3", async () => {
        const script: El = { tag: "script", attrs: { src: "https://www.google.com/recaptcha/api.js?render=explicit&onload=cb" } };
        expect((await detectCaptcha(fakePage([script, V2_BOX]) as never)).type).toBe("recaptcha-v2");
    });

    it("still reads a v3-only page as v3", async () => {
        expect(await detectCaptcha(fakePage([V3_SCRIPT, V3_BADGE]) as never)).toEqual({
            type: "recaptcha-v3",
            siteKey: "SITEKEY",
        });
    });
});

describe("quickCaptchaCheck", () => {
    it("flags an unticked v2 box", async () => {
        expect(await quickCaptchaCheck(fakePage([V2_DIV, V2_BOX, token("g-recaptcha-response", "")]))).toBe("recaptcha-v2");
    });

    it("ignores invisible v3 (nothing for the owner to tick)", async () => {
        expect(await quickCaptchaCheck(fakePage([V3_SCRIPT, V3_BADGE]))).toBeNull();
    });

    it("ignores a ticked box that stays on the page", async () => {
        expect(await quickCaptchaCheck(fakePage([V2_DIV, V2_BOX, token("g-recaptcha-response", "03AF")]))).toBeNull();
        const hc: El = { tag: "div", attrs: { class: "h-captcha" } };
        expect(await quickCaptchaCheck(fakePage([hc, token("h-captcha-response", "P1_x")]))).toBeNull();
        const ts: El = { tag: "div", attrs: { class: "cf-turnstile" } };
        expect(await quickCaptchaCheck(fakePage([ts, token("cf-turnstile-response", "0.x", "input")]))).toBeNull();
        expect(await quickCaptchaCheck(fakePage([ts, token("cf-turnstile-response", "", "input")]))).toBe("turnstile");
    });
});

describe("v3 bound to a button (Google's documented v3 pattern)", () => {
    const page = fakePage([
        { tag: "script", attrs: { src: "https://www.google.com/recaptcha/api.js?render=SITEKEY" } },
        { tag: "iframe", attrs: { src: "https://www.google.com/recaptcha/api2/anchor?k=SITEKEY&size=invisible" } },
        { tag: "button", attrs: { class: "g-recaptcha", "data-sitekey": "SITEKEY", "data-action": "submit" } },
        { tag: "textarea", attrs: { class: "g-recaptcha-response", name: "g-recaptcha-response" }, value: "" },
    ]);

    it("is invisible v3, so nobody is asked to tick a box that doesn't exist", async () => {
        expect((await detectCaptcha(page as never))?.type).toBe("recaptcha-v3");
        expect(await quickCaptchaCheck(page as never)).toBeNull();
    });
});
