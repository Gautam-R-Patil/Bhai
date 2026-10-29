// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { batchKey } from "./telegram-batch.js";

describe("telegram batch key", () => {
    it("never merges two senders in the same group chat", () => {
        expect(batchKey(-100, 1)).not.toBe(batchKey(-100, 2));
        expect(batchKey(-100, 1)).toBe(batchKey(-100, 1));
    });
});
