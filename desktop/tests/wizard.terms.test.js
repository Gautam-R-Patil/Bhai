// @vitest-environment jsdom
// Tests the rewritten Trust step (per-document clickwrap).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadStep() {
    // copy.js + terms.js are IIFE-bound to window. Load them in order.
    const copy = readFileSync(path.join(__dirname, "..", "wizard", "copy.js"), "utf8");
    const terms = readFileSync(path.join(__dirname, "..", "wizard", "steps", "terms.js"), "utf8");
    new Function(copy)();
    new Function(terms)();
}

describe("Trust step — per-document clickwrap", () => {
    let root;
    let openedUrls;
    let savedPayload;

    beforeEach(() => {
        document.body.innerHTML = "";
        root = document.createElement("div");
        document.body.appendChild(root);

        openedUrls = [];
        savedPayload = null;

        window.bhai = {
            openExternalUrl: vi.fn((url) => {
                openedUrls.push(url);
                return Promise.resolve({ success: true });
            }),
            saveLegalAcceptance: vi.fn((payload) => {
                savedPayload = payload;
                return Promise.resolve({ success: true });
            }),
        };
        window.WizardRouter = { CURRENT_ACCEPTANCE_VERSION: "2.0.0" };

        loadStep();
    });

    it("renders 5 document rows with unchecked boxes", () => {
        const handle = window.WizardSteps.terms.render(root, {});
        expect(handle.checkboxes.length).toBe(5);
        for (const c of handle.checkboxes) {
            expect(c.el.checked).toBe(false);
        }
    });

    it("renders the age/authority row unchecked", () => {
        const handle = window.WizardSteps.terms.render(root, {});
        expect(handle.ageCheckbox.checked).toBe(false);
    });

    it("CTA starts disabled", () => {
        const handle = window.WizardSteps.terms.render(root, {});
        expect(handle.cta.disabled).toBe(true);
    });

    it("CTA enables only when every box is ticked", () => {
        const handle = window.WizardSteps.terms.render(root, {});
        // Tick all 5 docs but leave age unticked → still disabled.
        for (const c of handle.checkboxes) {
            c.el.checked = true; c.el.dispatchEvent(new Event("change"));
        }
        expect(handle.cta.disabled).toBe(true);
        // Tick age too → enabled.
        handle.ageCheckbox.checked = true;
        handle.ageCheckbox.dispatchEvent(new Event("change"));
        expect(handle.cta.disabled).toBe(false);
    });

    it("each Read link opens the canonical URL via bhai.openExternalUrl", () => {
        const handle = window.WizardSteps.terms.render(root, {});
        const links = root.querySelectorAll(".legal-row-link");
        expect(links.length).toBe(5);
        for (const link of links) link.click();
        expect(openedUrls).toEqual([
            "https://tryatlasagi.com/terms",
            "https://tryatlasagi.com/privacy",
            "https://tryatlasagi.com/acceptable-use",
            "https://tryatlasagi.com/disclaimer",
            "https://tryatlasagi.com/refund",
        ]);
    });

    it("Hub link opens the /legal index", () => {
        window.WizardSteps.terms.render(root, {});
        const hub = root.querySelector(".legal-hub-link");
        hub.click();
        expect(openedUrls).toContain("https://tryatlasagi.com/legal");
    });

    it("submits a payload with documents map + consents flags", async () => {
        const handle = window.WizardSteps.terms.render(root, {
            onAdvance: vi.fn(),
        });
        for (const c of handle.checkboxes) {
            c.el.checked = true; c.el.dispatchEvent(new Event("change"));
        }
        handle.ageCheckbox.checked = true;
        handle.ageCheckbox.dispatchEvent(new Event("change"));
        handle.cta.click();
        // Let the promise chain resolve.
        await new Promise(r => setTimeout(r, 10));
        expect(savedPayload).toBeTruthy();
        expect(savedPayload.accepted).toBe(true);
        expect(savedPayload.version).toBe("2.0.0");
        expect(savedPayload.documents).toEqual({
            terms: "https://tryatlasagi.com/terms",
            privacy: "https://tryatlasagi.com/privacy",
            acceptableUse: "https://tryatlasagi.com/acceptable-use",
            disclaimer: "https://tryatlasagi.com/disclaimer",
            refund: "https://tryatlasagi.com/refund",
        });
        expect(savedPayload.consents).toEqual({
            documents: true,
            ageOrAuthority: true,
        });
    });

    it("CTA refuses to submit if even one box was un-ticked after enable", async () => {
        const handle = window.WizardSteps.terms.render(root, {});
        for (const c of handle.checkboxes) {
            c.el.checked = true; c.el.dispatchEvent(new Event("change"));
        }
        handle.ageCheckbox.checked = true;
        handle.ageCheckbox.dispatchEvent(new Event("change"));
        // User un-ticks one and clicks anyway.
        handle.checkboxes[2].el.checked = false;
        handle.checkboxes[2].el.dispatchEvent(new Event("change"));
        handle.cta.click();
        await new Promise(r => setTimeout(r, 10));
        expect(savedPayload).toBeNull();
    });
});
