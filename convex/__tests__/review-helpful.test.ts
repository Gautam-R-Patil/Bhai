// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A review's "helpful" count takes one vote per user, whoever keeps calling it.
import { expect, it } from "vitest";
import { markHelpful } from "../store/reviews";

it("a second vote from the same user doesn't count", async () => {
    let review: Record<string, unknown> = { _id: "r1", helpful: 0 };
    const ctx = {
        db: {
            get: async () => review,
            patch: async (_id: string, f: Record<string, unknown>) => {
                review = { ...review, ...f };
            },
        },
    };
    const vote = (userId: string) =>
        (markHelpful as unknown as { _handler: (c: unknown, a: unknown) => Promise<void> })._handler(ctx, { reviewId: "r1", userId });
    await vote("u1");
    await vote("u1");
    await vote("u2");
    expect(review.helpful).toBe(2);
    expect(review.helpfulBy).toEqual(["u1", "u2"]);
});
