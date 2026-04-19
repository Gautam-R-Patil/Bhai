// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatLogLine, escapeHtml, InstallLog } from "../../components/install-log.js";

describe("escapeHtml", () => {
    it("escapes the five basic chars", () => {
        expect(escapeHtml('<a href="x">&\'y</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&lt;/a&gt;");
    });
    it("coerces non-strings to strings", () => {
        expect(escapeHtml(42)).toBe("42");
        expect(escapeHtml(null)).toBe("null");
    });
});

describe("formatLogLine", () => {
    it("success line", () => {
        const r = formatLogLine({ text: "ok", severity: "ok" });
        expect(r.className).toBe("sp-log__line sp-log__line--ok");
        expect(r.hasActions).toBe(false);
        expect(r.html).toContain("ok");
    });
    it("error line with phaseId has Retry/Skip/Copy actions", () => {
        const r = formatLogLine({ text: "boom", severity: "err", phaseId: "playwright" });
        expect(r.className).toBe("sp-log__line sp-log__line--err");
        expect(r.hasActions).toBe(true);
        expect(r.html).toContain("Retry");
        expect(r.html).toContain("Skip");
        expect(r.html).toContain("Copy");
        expect(r.html).toContain("playwright");
    });
    it("error line without phaseId has no actions", () => {
        const r = formatLogLine({ text: "uh oh", severity: "err" });
        expect(r.hasActions).toBe(false);
        expect(r.html).not.toContain("Retry");
    });
    it("escapes HTML in text", () => {
        const r = formatLogLine({ text: "<script>x</script>", severity: "info" });
        expect(r.html).not.toContain("<script>");
        expect(r.html).toContain("&lt;script&gt;");
    });
    it("unknown severity falls back to info", () => {
        const r = formatLogLine({ text: "hm", severity: "weird" });
        expect(r.className).toBe("sp-log__line sp-log__line--info");
    });
    it("empty input is safe", () => {
        const r = formatLogLine();
        expect(r.className).toBe("sp-log__line sp-log__line--info");
        expect(r.hasActions).toBe(false);
    });
});

describe("InstallLog DOM", () => {
    let atlasCalls;
    beforeEach(() => {
        atlasCalls = { retries: [] };
        window.atlas = {
            setupRetryInstallPhase: async (phaseId) => {
                atlasCalls.retries.push(phaseId);
                return { ok: true };
            },
        };
        // jsdom doesn't implement clipboard — stub it.
        if (!navigator.clipboard) {
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: { writeText: async () => {} },
            });
        }
    });
    afterEach(() => { delete window.atlas; });

    it("throws when mounted without a container", () => {
        const l = new InstallLog({});
        expect(() => l.mount(null)).toThrow(/container is required/);
    });

    it("renders rows with the right severity class", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("building", "info");
        l.addLine("done", "ok");
        l.addLine("careful", "warn");
        const rows = c.querySelectorAll(".sp-log__line");
        expect(rows.length).toBe(3);
        expect(rows[0].className).toMatch(/sp-log__line--info/);
        expect(rows[1].className).toMatch(/sp-log__line--ok/);
        expect(rows[2].className).toMatch(/sp-log__line--warn/);
    });

    it("escapes text content in the DOM (not via innerHTML)", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("<script>alert(1)</script>", "info");
        const row = c.querySelector(".sp-log__line");
        expect(row.textContent).toBe("<script>alert(1)</script>");
        // Critical: no real script tag should exist under the row
        expect(row.querySelector("script")).toBe(null);
    });

    it("error line with phaseId renders three action buttons", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("playwright failed", "err", "playwright");
        const row = c.querySelector(".sp-log__line");
        expect(row.querySelector("[data-sp-retry]")).toBeTruthy();
        expect(row.querySelector("[data-sp-skip]")).toBeTruthy();
        expect(row.querySelector("[data-sp-copy]")).toBeTruthy();
    });

    it("error line WITHOUT phaseId has no action buttons", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("uh oh", "err");
        const row = c.querySelector(".sp-log__line");
        expect(row.querySelector("[data-sp-retry]")).toBe(null);
    });

    it("Retry click invokes setupRetryInstallPhase with the phaseId", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("broken", "err", "node");
        c.querySelector("[data-sp-retry]").click();
        expect(atlasCalls.retries).toEqual(["node"]);
    });

    it("Skip click calls props.onSkip(phaseId)", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const skips = [];
        const l = new InstallLog({ onSkip: (p) => skips.push(p) }).mount(c);
        l.addLine("broken", "err", "playwright");
        c.querySelector("[data-sp-skip]").click();
        expect(skips).toEqual(["playwright"]);
    });

    it("Copy click copies the line text to clipboard", async () => {
        const writes = [];
        navigator.clipboard.writeText = async (t) => { writes.push(t); };
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("broken thing", "err", "phase");
        c.querySelector("[data-sp-copy]").click();
        await Promise.resolve();
        expect(writes).toEqual(["broken thing"]);
    });

    it("clear() removes all rows", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("a", "info");
        l.addLine("b", "ok");
        expect(c.querySelectorAll(".sp-log__line").length).toBe(2);
        l.clear();
        expect(c.querySelectorAll(".sp-log__line").length).toBe(0);
    });

    it("unmount detaches the root element", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const l = new InstallLog({}).mount(c);
        l.addLine("a", "info");
        l.unmount();
        expect(c.firstElementChild).toBe(null);
    });
});
