// @vitest-environment jsdom
// Tests the persona step renderer + selection state + payload shape.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper: load the IIFE-wrapped step into the jsdom window.
async function loadPersonaStep() {
    document.body.innerHTML = '<div id="step-root"></div>';
    window.Copy = {
        _data: {
            persona: {
                eyebrow: "How you work",
                title: "Pick a starting shape.",
                sub: "Shapes the examples I show.",
                developer_title: "Developer", developer_desc: "Terminal-first.",
                developer_cap_1: "Codebase memory", developer_cap_2: "Shell + IDE", developer_cap_3: "Debug fast",
                founder_title: "Founder", founder_desc: "Calendar, comms.",
                founder_cap_1: "Meeting summaries", founder_cap_2: "Calendar + email", founder_cap_3: "Research to decision",
                creator_title: "Creator", creator_desc: "Ideas, media.",
                creator_cap_1: "References", creator_cap_2: "Script generation", creator_cap_3: "Asset corral",
                researcher_title: "Researcher", researcher_desc: "Sources.",
                researcher_cap_1: "Deep research", researcher_cap_2: "Citations", researcher_cap_3: "Hypothesis",
                explorer_title: "Explorer", explorer_desc: "Not sure yet.",
                explorer_cap_1: "No bias", explorer_cap_2: "Adapts", explorer_cap_3: "Pick later",
            },
        },
        get(stepId, key) { return (this._data[stepId] && this._data[stepId][key]) || null; },
    };
    window.WizardSteps = {};
    // Re-import the persona step IIFE each test (it registers on
    // window.WizardSteps when loaded as a side effect).
    const mod = await import("../wizard/steps/persona.js?" + Date.now());
    return mod;
}

describe("persona step — render", () => {
    beforeEach(async () => { await loadPersonaStep(); });

    it("renders five persona cards", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: {} } });
        const cards = root.querySelectorAll(".persona-card");
        expect(cards.length).toBe(5);
        const ids = Array.from(cards).map((c) => c.getAttribute("data-persona-id"));
        expect(ids).toEqual(["developer", "founder", "creator", "researcher", "explorer"]);
    });

    it("Continue is disabled until a card is selected", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: {} } });
        const cta = root.querySelector(".step-actions .btn-primary");
        expect(cta.disabled).toBe(true);
        const devCard = root.querySelector('[data-persona-id="developer"]');
        devCard.click();
        expect(cta.disabled).toBe(false);
        expect(devCard.classList.contains("active")).toBe(true);
    });

    it("clicking a different card moves active state", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: {} } });
        const dev = root.querySelector('[data-persona-id="developer"]');
        const founder = root.querySelector('[data-persona-id="founder"]');
        dev.click(); founder.click();
        expect(dev.classList.contains("active")).toBe(false);
        expect(founder.classList.contains("active")).toBe(true);
    });

    it("pre-selects the persona from state.profile.persona", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: { persona: "researcher" } } });
        const researcher = root.querySelector('[data-persona-id="researcher"]');
        expect(researcher.classList.contains("active")).toBe(true);
    });
});

describe("persona step — Continue payload", () => {
    beforeEach(async () => { await loadPersonaStep(); });

    it("calls bhai.saveProfile with the expected shape", async () => {
        const root = document.getElementById("step-root");
        const saveProfile = vi.fn().mockResolvedValue({ success: true });
        const onAdvance = vi.fn();
        const refreshState = vi.fn().mockResolvedValue(undefined);
        window.bhai = { saveProfile };
        window.WizardSteps.persona.render(root, {
            state: { profile: { name: "Dheeraj" } },
            onAdvance, refreshState,
        });
        root.querySelector('[data-persona-id="developer"]').click();
        root.querySelector(".step-actions .btn-primary").click();
        // Wait for the async handler to settle.
        await new Promise((r) => setTimeout(r, 20));
        expect(saveProfile).toHaveBeenCalledTimes(1);
        const payload = saveProfile.mock.calls[0][0];
        expect(payload.name).toBe("Dheeraj");
        expect(payload.persona).toBe("developer");
        expect(payload.tone).toBe("professional");
        expect(payload.personaConfidence).toBe(1.0);
        expect(typeof payload.personaSelectedAt).toBe("number");
        expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    it("preserves existing tone if profile.tone is already set", async () => {
        const root = document.getElementById("step-root");
        const saveProfile = vi.fn().mockResolvedValue({ success: true });
        window.bhai = { saveProfile };
        window.WizardSteps.persona.render(root, {
            state: { profile: { name: "X", tone: "playful" } },
            onAdvance: () => {}, refreshState: async () => {},
        });
        root.querySelector('[data-persona-id="developer"]').click();
        root.querySelector(".step-actions .btn-primary").click();
        await new Promise((r) => setTimeout(r, 20));
        expect(saveProfile.mock.calls[0][0].tone).toBe("playful");
    });

    it("creator defaults tone to friendly", async () => {
        const root = document.getElementById("step-root");
        const saveProfile = vi.fn().mockResolvedValue({ success: true });
        window.bhai = { saveProfile };
        window.WizardSteps.persona.render(root, {
            state: { profile: {} },
            onAdvance: () => {}, refreshState: async () => {},
        });
        root.querySelector('[data-persona-id="creator"]').click();
        root.querySelector(".step-actions .btn-primary").click();
        await new Promise((r) => setTimeout(r, 20));
        expect(saveProfile.mock.calls[0][0].tone).toBe("friendly");
    });
});

describe("persona step — _internals export", () => {
    it("exposes PERSONAS and TONE_DEFAULTS", async () => {
        const mod = await import("../wizard/steps/persona.js");
        const internals = (mod.default && mod.default._internals) || mod._internals;
        expect(internals.PERSONAS).toEqual(["developer", "founder", "creator", "researcher", "explorer"]);
        expect(internals.TONE_DEFAULTS.developer).toBe("professional");
        expect(internals.TONE_DEFAULTS.creator).toBe("friendly");
    });
});
