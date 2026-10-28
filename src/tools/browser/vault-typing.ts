// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Typing a saved secret (security/vault.ts) into the browser. The origin is
// checked where the keys land, right before they are typed: the live tab (the
// Chrome proxy's URL is a cache), and in Playwright the frame that holds focus.
// The Chrome extension checks it again inside the page, in the same step that
// types. Afterwards the field is drawn as dots (screenshots) and the document
// is marked, so page JavaScript can't read the value back in a form masking
// wouldn't recognize.

import { noteSecretTyped, secretTypedIn, vaultCall, vaultTargetError } from "../../security/vault.js";

type AnyPage = any;
type AnyFrame = any;

const isChromeProxy = (page: AnyPage) => typeof page?.liveUrl === "function";

/** The live top-level URL (the Chrome proxy's url() is cached; ask the extension). */
export async function liveUrl(page: AnyPage): Promise<string> {
    return isChromeProxy(page) ? page.liveUrl() : page.url();
}

/**
 * Where a keystroke lands now. Playwright: follow document.activeElement down
 * through iframes to the frame holding focus; "" when it can't be told. The
 * extension types into the top document (it re-checks there).
 */
async function focusTarget(page: AnyPage): Promise<{ top: string; frameUrl: string; frame: AnyFrame | null }> {
    const top = await liveUrl(page);
    if (isChromeProxy(page)) return { top, frameUrl: top, frame: null };
    let frame = page.mainFrame();
    for (let depth = 0; depth < 6; depth++) {
        const active = await frame.evaluateHandle("document.activeElement");
        const inFrame = await active.evaluate(
            /* javascript-obfuscator:disable */ (el: Element | null) => !!el && /^(IFRAME|FRAME)$/.test(el.tagName),
            /* javascript-obfuscator:enable */ undefined,
        );
        if (!inFrame) return { top, frameUrl: frame.url(), frame };
        let next: AnyFrame = null;
        for (const child of frame.childFrames()) {
            const el = await child.frameElement().catch(() => null);
            const same =
                el &&
                (await frame.evaluate(
                    /* javascript-obfuscator:disable */ ([a, b]: unknown[]) => a === b,
                    /* javascript-obfuscator:enable */ [active, el],
                ));
            if (same) {
                next = child;
                break;
            }
        }
        if (!next) break;
        frame = next;
    }
    return { top, frameUrl: "", frame: null };
}

/** Draws the focused field as dots, so a screenshot doesn't show the typed value. */
const HIDE_FOCUSED_JS = `(() => { const el = document.activeElement; if (el && el.type !== "password" && el.style) el.style.setProperty("-webkit-text-security", "disc"); })()`;

// The top document's origin. Taint is keyed on origin alone (not origin+timeOrigin):
// Back/forward or a reload to a no-store page loads a NEW document (new timeOrigin)
// into which the browser refills the typed field — so the lock has to outlive the
// document and cover every page on that origin for the rest of the task.
const docOf = async (page: AnyPage): Promise<string> =>
    String((await page.evaluate("location.origin").catch(() => "")) ?? "");

/**
 * Types `text` (it holds resolved vault values) where focus is, if the vault
 * call's rules allow that origin now (`clear`: the extension replaces the
 * field). Returns an error, or null once typed.
 */
export async function typeVaultText(page: AnyPage, text: string, clear = false): Promise<string | null> {
    const rules = vaultCall()?.rules ?? [];
    if (!rules.length) return "A saved secret reached the browser without its site check. Refused, nothing was typed.";
    const t = await focusTarget(page);
    const err = vaultTargetError(rules, t.top, t.frameUrl);
    if (err) return err;
    if (isChromeProxy(page)) {
        // The extension checks the page's origin again, in the step that types.
        await page.keyboard.type(text, { vaultRules: rules, clear });
    } else {
        await page.keyboard.type(text); // in one go: no gap after the check
        await t.frame?.evaluate(HIDE_FOCUSED_JS).catch(() => {});
    }
    const doc = await docOf(page);
    if (doc) noteSecretTyped(doc);
    return null;
}

/** Refuses page JavaScript on a document a saved secret was typed into, until it navigates. */
export async function vaultTaintError(page: AnyPage): Promise<string | null> {
    const doc = await docOf(page);
    return doc && secretTypedIn(doc)
        ? "A saved secret was typed on this page, so page JavaScript is off here until the page navigates (it could read the value back). Use browser_scan / browser_extract instead."
        : null;
}
