// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { parseAccelerator, isModifierKey } from "../../components/hotkey-picker.js";

function evt(o) {
    return Object.assign({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "KeyK", key: "k" }, o || {});
}

describe("parseAccelerator", () => {
    it("Cmd+Shift+K on darwin", () => { expect(parseAccelerator(evt({ metaKey: true, shiftKey: true }), "darwin")).toBe("CmdOrCtrl+Shift+K"); });
    it("Ctrl+Shift+K on win32", () => { expect(parseAccelerator(evt({ ctrlKey: true, shiftKey: true }), "win32")).toBe("CmdOrCtrl+Shift+K"); });
    it("Alt+Space", () => { expect(parseAccelerator(evt({ altKey: true, code: "Space", key: " " }), "darwin")).toBe("Alt+Space"); });
    it("F5", () => { expect(parseAccelerator(evt({ code: "F5", key: "F5" }), "darwin")).toBe("F5"); });
    it("Alt+ArrowLeft → Alt+Left", () => { expect(parseAccelerator(evt({ altKey: true, code: "ArrowLeft", key: "ArrowLeft" }), "darwin")).toBe("Alt+Left"); });
    it("rejects modifier-only", () => { expect(parseAccelerator(evt({ metaKey: true, code: "MetaLeft", key: "Meta" }), "darwin")).toBeNull(); });
    it("uppercases letters", () => { expect(parseAccelerator(evt({ metaKey: true, code: "KeyA", key: "a" }), "darwin")).toBe("CmdOrCtrl+A"); });
});

describe("isModifierKey", () => {
    it("modifiers", () => { ["Meta", "Shift", "Control", "Alt"].forEach((k) => expect(isModifierKey(k)).toBe(true)); });
    it("letter", () => { expect(isModifierKey("a")).toBe(false); });
});
