// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { deviceLabel } from "./devices";

describe("device names from session fingerprints", () => {
    it("shows the computer's name and OS", () => {
        expect(deviceLabel("darwin:Dheerajs-MacBook-Pro.local:dheeraj")).toEqual({ name: "Dheerajs-MacBook-Pro", platform: "macOS" });
        expect(deviceLabel("win32:DESKTOP-7Q2:priya")).toEqual({ name: "DESKTOP-7Q2", platform: "Windows" });
        expect(deviceLabel("linux:devbox:root")).toEqual({ name: "devbox", platform: "Linux" });
        expect(deviceLabel("")).toEqual({ name: "Unknown device", platform: "Unknown" });
    });
});
