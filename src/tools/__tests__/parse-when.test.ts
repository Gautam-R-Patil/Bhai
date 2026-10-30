// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// gpt-4.1-nano gave "2023-10-09 10:00" for "tomorrow at 10am": reminders take words now.
import { describe, expect, it } from "vitest";
import { parseWhen } from "../app-integrations.js";

const now = new Date(2026, 9, 30, 12, 0); // Fri 30 Oct 2026, noon
const at = (t: string) => {
    const d = parseWhen(t, now);
    return d && `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("parseWhen", () => {
    it("reads the ways people say when", () => {
        expect(at("tomorrow at 10am")).toBe("10/31 10:00");
        expect(at("tomorrow 5:30 pm")).toBe("10/31 17:30");
        expect(at("today 3pm")).toBe("10/30 15:00");
        expect(at("tonight")).toBe("10/30 20:00");
        expect(at("monday 9am")).toBe("11/2 9:00");
        expect(at("friday 9am")).toBe("11/6 9:00"); // a weekday is the next one, not today
        expect(at("in 2 hours")).toBe("10/30 14:00");
        expect(at("2026-11-02 14:30")).toBe("11/2 14:30");
        expect(at("12pm")).toBe("10/30 12:00");
        expect(at("12am")).toBe("10/30 0:00");
        expect(at("whenever")).toBeNull();
    });
});
