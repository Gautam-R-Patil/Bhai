// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The calculator tool takes what models write and gives Calculator only keys it reads as arithmetic.
import { describe, expect, it } from "vitest";
import { calcExpression } from "../app-integrations.js";

describe("calcExpression", () => {
    it("turns words into operators", () => {
        expect(calcExpression("123 times 45")).toBe("123 * 45");
        expect(calcExpression("17 x 23 plus 100")).toBe("17 * 23 + 100");
        expect(calcExpression("1,234 divided by 2 =")).toBe("1234 / 2");
        expect(calcExpression("(42 − 7)")).toBe("(42 - 7)"); // a Unicode minus is its minus key
        expect(calcExpression("(42 - 7) / 5")).toBe("(42 - 7) / 5");
    });
    it("refuses letters Calculator would read as function keys", () => {
        expect(calcExpression("log 5")).toBeNull();
        expect(calcExpression("")).toBeNull();
    });
});
