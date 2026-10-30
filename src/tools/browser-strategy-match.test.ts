// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A saved browser strategy rides along only when the task is really like it: "what do
// you know about me?" got "extract data from unknown" ("know" is inside "unknown").
import { expect, it } from "vitest";
import { findStrategy, recordStrategy } from "./browser-memory.js";

const ok = [{ action: "navigate", success: true, durationMs: 100 }] as never;

it("matches whole meaningful words, at least two, or the domain", () => {
    recordStrategy("extract data from unknown", "unknown", ok, "");
    recordStrategy("extract prices from www.smartprix.com", "www.smartprix.com", ok, "");
    recordStrategy("interact with form on example.com", "example.com", ok, "");

    expect(findStrategy("what do you know about me?")).toBeNull();
    expect(findStrategy("send an email from my gmail with the report")).toBeNull();
    expect(findStrategy("extract prices from smartprix for this phone")?.taskPattern).toMatch(/smartprix/);
    expect(findStrategy("fill the signup form", "example.com")?.domain).toBe("example.com");
    recordStrategy("browse news.ycombinator.com", "news.ycombinator.com", [], ""); // no steps
    expect(findStrategy("browse news.ycombinator.com")?.successRate).toBe(0); // not NaN
});
