// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("awakening DOM snapshot", () => {
    beforeEach(() => {
        document.body.innerHTML = '<article id="step-root"></article>';
        // Freeze time so the greeting word ("Good evening", "Good morning", …)
        // is deterministic across runs. 10:00 → "Good morning".
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 4, 16, 10, 0, 0));
        // Minimal Copy stub
        window.Copy = {
            get: function (step, key) {
                const m = {
                    "awakening.status1": "reading the room",
                    "awakening.status2": "setting the table",
                    "awakening.status3": "ready when you are",
                    "awakening.cta": "Begin",
                    "awakening.hint": "Press ESC to skip",
                };
                return m[step + "." + key] || "";
            },
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("renders the expected skeleton", async () => {
        await import("../wizard/steps/awakening.js");
        const root = document.getElementById("step-root");
        const ctx = { state: { profile: { name: "Test" } }, onAdvance: function () {} };
        window.WizardSteps.awakening.render(root, ctx);

        const html = root.innerHTML
            .replace(/--word-delay: \d+ms;/g, "--word-delay: Xms;");
        expect(html).toMatchInlineSnapshot(`"<div class="awakening"><div class="awakening-glyph"></div><h1 class="awakening-greet"><span class="word" style="--word-delay: Xms;">Good</span><span class="space"></span><span class="word" style="--word-delay: Xms;">morning,</span><span class="space"></span><span class="word" style="--word-delay: Xms;">Test.</span></h1><div class="awakening-iri"></div><div class="awakening-status"><span class="swap">reading the room</span></div><div class="awakening-cta"><button type="button" class="btn btn-primary">Begin <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"></polyline></svg></span></button><div class="hint">Press ESC to skip</div></div></div>"`);

        // Cleanup any timers the renderer scheduled.
        if (typeof root._cleanup === "function") root._cleanup();
    });
});
