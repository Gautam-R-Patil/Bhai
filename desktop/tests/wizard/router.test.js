// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import * as router from "../../wizard/router.js";

const { getSteps, next, prev, ALL_STEPS } = router;

const fresh = () => ({
    platform: "darwin",
    isReconfigure: false,
    account: { signedIn: false },
    profile: {},
    permissions: { accessibility: "denied", screen: "denied", microphone: "denied", location: "denied" },
    installed: { node: false, playwright: false, embeddingModel: false, sox: false },
    hotkey: { current: "Alt+Space", conflicts: [] },
    workspace: { path: "", exists: false },
});

const full = () => ({
    platform: "darwin",
    isReconfigure: false,
    account: { signedIn: true, email: "a@b.com" },
    profile: { name: "D", tone: "friendly" },
    permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" },
    installed: { node: true, playwright: true, embeddingModel: true, sox: true },
    hotkey: { current: "Alt+Space", conflicts: [] },
    workspace: { path: "/tmp/ws", exists: true },
    personalize: { hotkey: "Alt+Space", theme: "dark", voice: { backend: "gemini-live", name: "Aoede" }, wakeWord: { enabled: false, phrase: "Hey Atlas" } },
    setupFinalized: true,
});

describe("WizardRouter.getSteps", () => {
    it("fresh Mac → all 6 steps, Welcome header", () => {
        const { steps, header } = getSteps(fresh());
        expect(steps).toEqual(["welcome", "signin", "profile", "personalize", "permissions", "install"]);
        expect(header).toBe("Welcome");
    });
    it("signed in + no profile → [profile, personalize, permissions, install]", () => {
        const s = fresh();
        s.account = { signedIn: true, email: "a@b.com" };
        expect(getSteps(s).steps).toEqual(["profile", "personalize", "permissions", "install"]);
    });
    it("fully configured → empty list", () => {
        expect(getSteps(full()).steps).toEqual([]);
    });
    it("reconfigure → header Reconfigure, steps shown without welcome", () => {
        const s = full();
        s.isReconfigure = true;
        const { steps, header } = getSteps(s);
        expect(header).toBe("Reconfigure");
        expect(steps).toContain("profile");
        expect(steps).toContain("install");
        expect(steps).not.toContain("welcome");
    });
    it("Windows → permissions excluded regardless of state", () => {
        const s = fresh();
        s.platform = "win32";
        expect(getSteps(s).steps).not.toContain("permissions");
    });
    it("hotkey conflict → forces personalize even if otherwise complete", () => {
        const s = full();
        s.hotkey.conflicts = ["Spotlight"];
        expect(getSteps(s).steps).toContain("personalize");
    });
    it("handles a nullish state by returning the default welcome header + empty steps or fresh", () => {
        const { header } = getSteps(undefined);
        expect(header).toBe("Welcome");
    });
});

describe("WizardRouter.next/prev + ALL_STEPS", () => {
    it("next walks forward and returns -1 at end", () => {
        const s = ["profile", "personalize", "permissions", "install"];
        expect(next(0, s)).toBe(1);
        expect(next(2, s)).toBe(3);
        expect(next(3, s)).toBe(-1);
    });
    it("prev walks backward and returns -1 at start", () => {
        expect(prev(0)).toBe(-1);
        expect(prev(2)).toBe(1);
    });
    it("ALL_STEPS canonical order", () => {
        expect(ALL_STEPS).toEqual(["welcome", "signin", "profile", "personalize", "permissions", "install"]);
    });
});
