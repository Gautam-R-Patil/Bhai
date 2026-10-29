// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS redacts the Wi-Fi name for apps without Location access; that is not "disconnected".
import { expect, it } from "vitest";
import { parseMacWifi } from "./platform-bridge.js";

const summary = (ssid: string, active = "TRUE") => `<dictionary> {\n  InterfaceType : WiFi\n  LinkStatusActive : ${active}\n  SSID : ${ssid}\n}`;

it("reads the name when macOS shows it, and says when it is hidden", () => {
    expect(parseMacWifi("Current Wi-Fi Network: Home 5G\n", "")).toEqual({ connected: true, ssid: "Home 5G", nameHidden: false });
    const hidden = "You are not associated with an AirPort network.\n";
    expect(parseMacWifi(hidden, summary("<redacted>"))).toEqual({ connected: true, ssid: null, nameHidden: true });
    expect(parseMacWifi(hidden, summary("Cafe"))).toEqual({ connected: true, ssid: "Cafe", nameHidden: false });
    expect(parseMacWifi(hidden, summary("<redacted>", "FALSE"))).toEqual({ connected: false, ssid: null, nameHidden: false });
    expect(parseMacWifi("", "")).toEqual({ connected: false, ssid: null, nameHidden: false });
});
