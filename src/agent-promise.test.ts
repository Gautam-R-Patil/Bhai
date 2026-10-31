// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { expect, it } from "vitest";
import { announcesWithoutDoing } from "./agent.js";

it("a reply that only promises to go and look is caught; an answer or a sign-off isn't", () => {
    expect(announcesWithoutDoing("Kal ka asli haal nikaalta hoon, last time numbers thode gande the.")).toBe(true);
    expect(announcesWithoutDoing("On it, let me check the forecast.")).toBe(true);
    expect(announcesWithoutDoing("I'll look that up for you.")).toBe(true);
    expect(announcesWithoutDoing("It's 19°C and hazy. Let me know if you want tomorrow too.")).toBe(false);
    expect(announcesWithoutDoing("I'll be here if you need me.")).toBe(false);
    expect(announcesWithoutDoing("Sure, I'll keep that in mind.")).toBe(false);
});
