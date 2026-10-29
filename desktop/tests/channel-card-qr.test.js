// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Regression: the WhatsApp QR listener is attached once per ChannelCard, but
// it used to close over the FIRST attempt's render functions. On any retry
// (Try again / a second Generate QR) the attempt counter advanced and those
// stale renderers early-returned, so the QR never drew again. The listener
// must dispatch to the ACTIVE attempt's renderers.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelCard } from "../components/channel-card.js";

let qrCallback;
let container;

beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    container = document.getElementById("host");
    qrCallback = null;
    // Force the plain-code QR fallback (no real canvas renderer in jsdom).
    window.QRCode = {};
    window.atlas = {
        onWhatsAppQR: vi.fn((cb) => { qrCallback = cb; }), // preload registers once
        setupWaPairCancel: vi.fn(() => Promise.resolve({ ok: true })),
        setupWaPairStart: vi.fn(() => Promise.resolve({ ok: true })),
    };
});

function qrBoxText() {
    return container.querySelector("[data-sp-qr]").textContent;
}

describe("ChannelCard WhatsApp QR — retry renders", () => {
    it("renders the QR on the SECOND attempt, not just the first", async () => {
        const card = new ChannelCard({ type: "whatsapp" });
        card.mount(container);

        // Attempt 1
        await card._startWhatsApp();
        expect(typeof qrCallback).toBe("function");
        qrCallback("QR-STRING-1");
        expect(qrBoxText()).toContain("QR-STRING-1");

        // Attempt 2 (simulating "Try again"): listener is NOT re-attached.
        await card._startWhatsApp();
        expect(window.atlas.onWhatsAppQR).toHaveBeenCalledTimes(1);
        expect(qrBoxText()).toContain("Generating"); // reset to the generating state

        // The one live listener must still render for the active attempt.
        qrCallback("QR-STRING-2");
        expect(qrBoxText()).toContain("QR-STRING-2");

        card.unmount();
    });

    it("fires onSaved when 'connected' arrives on a later attempt", async () => {
        const onSaved = vi.fn();
        const card = new ChannelCard({ type: "whatsapp", onSaved });
        card.mount(container);
        await card._startWhatsApp();
        await card._startWhatsApp();
        qrCallback("connected");
        expect(onSaved).toHaveBeenCalledWith("whatsapp");
        card.unmount();
    });
});
