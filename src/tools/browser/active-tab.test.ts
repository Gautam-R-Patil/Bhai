// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A followed tab (popup / target=_blank) that closes returns focus to its opener,
// not to whichever tab is last.
import { describe, expect, it } from "vitest";
import { pickActivePage, setActivePageIndex } from "./core.js";

const tab = (name: string) => ({ name, closed: false, isClosed() { return this.closed; } });

describe("pickActivePage", () => {
    it("returns to the opener when the followed tab closes", () => {
        const [a, b, c, popup] = [tab("A"), tab("B"), tab("C"), tab("popup")];
        setActivePageIndex(3, { page: popup, opener: a });
        expect(pickActivePage([a, b, c, popup])).toBe(popup);
        popup.closed = true; // OAuth popup window.close(), or close_active
        expect(pickActivePage([a, b, c])).toBe(a);
        expect(pickActivePage([a, b, c])).toBe(a);
    });
    it("an explicit switch forgets the followed tab; otherwise clamps", () => {
        const [a, b, popup] = [tab("A"), tab("B"), tab("popup")];
        setActivePageIndex(2, { page: popup, opener: a });
        setActivePageIndex(2);
        popup.closed = true;
        expect(pickActivePage([a, b])).toBe(b);
    });
});
