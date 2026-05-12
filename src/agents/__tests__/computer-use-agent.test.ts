// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { parseAction } from "../computer-use-agent.js";

describe("parseAction — pixel coordinate clicks", () => {
    it("parses (x:412, y:318) form", () => {
        expect(parseAction("Click Safari icon (x:412, y:318)")).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("parses (x=412, y=318) form", () => {
        expect(parseAction("Click button (x=412, y=318)")).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("parses plain (412, 318) form", () => {
        expect(parseAction("Click at (412, 318)")).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("parses x=412 y=318 form (no parens, with equals)", () => {
        expect(parseAction("Click at x=412 y=318")).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("parses 'at coordinates 412, 318' form", () => {
        expect(parseAction("Click button at coordinates 412, 318")).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("parses 'at position 412 318' form", () => {
        expect(parseAction("Tap at position 412 318")).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("preserves move intent (not click) when phrasing says move/hover", () => {
        expect(parseAction("Hover at (412, 318)")).toEqual({ type: "move", x: 412, y: 318 });
        expect(parseAction("Move to (50, 60)")).toEqual({ type: "move", x: 50, y: 60 });
    });
});

describe("parseAction — percentage coordinates", () => {
    it("parses (50%, 30%) form", () => {
        const r = parseAction("Click at (50%, 30%)");
        expect(r.type).toBe("click");
        expect(r.percentX).toBeCloseTo(0.5, 3);
        expect(r.percentY).toBeCloseTo(0.3, 3);
    });

    it("parses x=50% y=30% form", () => {
        const r = parseAction("Click at x=50% y=30%");
        expect(r.percentX).toBeCloseTo(0.5, 3);
        expect(r.percentY).toBeCloseTo(0.3, 3);
    });

    it("parses normalized 0..1 floats", () => {
        const r = parseAction("Click at (0.42, 0.18)");
        expect(r.percentX).toBeCloseTo(0.42, 3);
        expect(r.percentY).toBeCloseTo(0.18, 3);
    });

    it("does NOT mis-parse fractional looking pixel coords", () => {
        // Anything outside parens with explicit decimal isn't treated as percentage
        const r = parseAction("Click at (412, 318)");
        expect(r.x).toBe(412);
        expect(r.percentX).toBeUndefined();
    });
});

describe("parseAction — JSON structured input", () => {
    it("parses JSON click action", () => {
        const r = parseAction('{"action":"click","x":412,"y":318}');
        expect(r).toEqual({ type: "click", x: 412, y: 318 });
    });

    it("parses JSON click with percent coords", () => {
        const r = parseAction('{"action":"click","percentX":0.42,"percentY":0.18}');
        expect(r.type).toBe("click");
        expect(r.percentX).toBe(0.42);
        expect(r.percentY).toBe(0.18);
    });

    it("parses JSON type action", () => {
        const r = parseAction('{"action":"type","text":"hello world"}');
        expect(r).toEqual({ type: "type", text: "hello world" });
    });

    it("parses JSON key action", () => {
        const r = parseAction('{"action":"key","key":"enter"}');
        expect(r).toEqual({ type: "key", key: "enter" });
    });

    it("parses JSON wrapped in surrounding text", () => {
        const r = parseAction('Step 3: emit {"action":"click","x":100,"y":200} to select Save');
        expect(r).toEqual({ type: "click", x: 100, y: 200 });
    });
});

describe("parseAction — text-target click (no coords)", () => {
    it("parses 'Click on Save button'", () => {
        expect(parseAction("Click on Save button")).toEqual({ type: "click", text: "Save" });
    });

    it("parses 'Click the Cancel link'", () => {
        expect(parseAction("Click the Cancel link")).toEqual({ type: "click", text: "Cancel" });
    });

    it("parses 'Tap Settings'", () => {
        expect(parseAction("Tap Settings")).toEqual({ type: "click", text: "Settings" });
    });
});

describe("parseAction — type / key / scroll / launch / screenshot / wait", () => {
    it('parses double-quoted typing: type "hello"', () => {
        expect(parseAction('Type "hello world"')).toEqual({ type: "type", text: "hello world" });
    });

    it("parses single-quoted typing: type 'hello'", () => {
        expect(parseAction("Type 'hello world'")).toEqual({ type: "type", text: "hello world" });
    });

    it("parses bare typing: type hello world", () => {
        const r = parseAction("Type hello world");
        expect(r.type).toBe("type");
        expect(r.text).toBe("hello world");
    });

    it("parses key press: 'Press Enter'", () => {
        expect(parseAction("Press Enter")).toEqual({ type: "key", key: "Enter" });
    });

    it("parses scroll up/down", () => {
        expect(parseAction("Scroll up")).toEqual({ type: "scroll", direction: "up" });
        expect(parseAction("Scroll down")).toEqual({ type: "scroll", direction: "down" });
    });

    it("parses 'Open Safari' as launch", () => {
        expect(parseAction("Open Safari")).toEqual({ type: "launch", app: "Safari" });
    });

    it("parses 'Launch Calculator app'", () => {
        expect(parseAction("Launch Calculator app")).toEqual({ type: "launch", app: "Calculator" });
    });

    it("parses 'take a screenshot'", () => {
        expect(parseAction("Take a screenshot of the screen")).toEqual({ type: "screenshot" });
    });

    it("parses 'wait 2 seconds'", () => {
        expect(parseAction("Wait 2 seconds")).toEqual({ type: "wait", delay: 2000 });
    });

    it("parses 'wait 500ms'", () => {
        expect(parseAction("Wait 500ms")).toEqual({ type: "wait", delay: 500 });
    });
});

describe("parseAction — regression: bugs from Phase 0 audit", () => {
    it("Bug-1a: previously failed on (412, 318) without x:/y: labels", () => {
        const r = parseAction("Click at (412, 318)");
        expect(r.type).toBe("click");
        expect(r.x).toBe(412);
        expect(r.y).toBe(318);
    });

    it("Bug-1b: previously failed on 'at coordinates 412, 318'", () => {
        const r = parseAction("Click button at coordinates 412, 318");
        expect(r.x).toBe(412);
    });

    it("Bug-1c: previously incorrectly fell back to typing for any click-without-coords text", () => {
        const r = parseAction("Click on Save");
        expect(r.type).toBe("click");
        expect(r.text).toBe("Save");
        expect(r.x).toBeUndefined();
    });
});
