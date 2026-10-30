// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A remark about a page that missed the topic isn't a research finding (they became memories).
import { expect, it } from "vitest";
import { isAboutThePage } from "./analysis.js";

it("drops remarks about the page, keeps findings that cite it", () => {
    for (const f of [
        "The page provides no dates, project timelines, or completion status for Phase 2.",
        "The page's text contains no dates, project timelines or metro information.",
        "This article does not mention Bengaluru metro at all.",
        "The fetched page doesn't cover the topic.",
    ])
        expect(isAboutThePage(f), f).toBe(true);
    for (const f of [
        "Phase 2A (Silk Board to KR Puram) is targeted to open by June 2026.",
        "The page states the Pink Line's 7.5-km elevated section opens in 2026.",
        "The article reports BMRCL had continuous cash losses since 2019.",
        "The site lists 36 stations on the Blue Line.",
    ])
        expect(isAboutThePage(f), f).toBe(false);
});
