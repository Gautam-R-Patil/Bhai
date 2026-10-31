// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { expect, it } from "vitest";
import { askedToBeBrief } from "./agent.js";

it("an ask for a short answer is recognised (no 'another pass' after a short reply to it)", () => {
    expect(askedToBeBrief("Search the web for the population of Bengaluru in 2026 and answer in two sentences.")).toBe(true);
    expect(askedToBeBrief("what's the weather? one line")).toBe(true);
    expect(askedToBeBrief("briefly, what changed in Node 26?")).toBe(true);
    expect(askedToBeBrief("set up the project and run the tests")).toBe(false);
});
