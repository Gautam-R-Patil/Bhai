// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Emotions and episodes come from what the owner said, not from Bhai reciting stored memory:
// asked "what do you know about me?", Bhai listed past setbacks and reflection saved them again.
import { expect, it } from "vitest";
import { ownerWords, saidByOwner } from "../reflection.js";

it("a recap by the assistant isn't the owner saying it; the owner's own words are", () => {
    const recap = ownerWords([
        { role: "user", content: "what do you know about me? 3 short lines\n\n[SOURCE: Desktop overlay chat — respond here, NOT on Telegram.]" },
        { role: "assistant", content: "Lately it's been rough: the demo crashed in front of a client and your Delhi flight got cancelled." },
    ] as never);
    expect(saidByOwner("Demo crashed in front of a client", recap)).toBe(false);
    expect(saidByOwner("Delhi flight got cancelled", recap)).toBe(false);

    const vent = ownerWords([{ role: "user", content: "ugh long day, the demo crashed twice in front of the client" }] as never);
    expect(saidByOwner("Product demo crashed twice in front of a client", vent)).toBe(true);
    expect(saidByOwner("stressed about the launch", ownerWords([{ role: "user", content: "so stressed, we launch tomorrow" }] as never))).toBe(true);
});
