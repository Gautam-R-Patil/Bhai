// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS redacts the Wi-Fi name for apps without Location access; that is not "disconnected".
import { expect, it } from "vitest";
import type { AxNode } from "../screen/ax-dump.js";
import { parseMacWifi, wifiNameFromPane } from "./platform-bridge.js";

const summary = (ssid: string, active = "TRUE") => `<dictionary> {\n  InterfaceType : WiFi\n  LinkStatusActive : ${active}\n  SSID : ${ssid}\n}`;

it("reads the name when macOS shows it, and says when it is hidden", () => {
    expect(parseMacWifi("Current Wi-Fi Network: Home 5G\n", "")).toEqual({ connected: true, ssid: "Home 5G", nameHidden: false });
    const hidden = "You are not associated with an AirPort network.\n";
    expect(parseMacWifi(hidden, summary("<redacted>"))).toEqual({ connected: true, ssid: null, nameHidden: true });
    expect(parseMacWifi(hidden, summary("Cafe"))).toEqual({ connected: true, ssid: "Cafe", nameHidden: false });
    expect(parseMacWifi(hidden, summary("<redacted>", "FALSE"))).toEqual({ connected: false, ssid: null, nameHidden: false });
    expect(parseMacWifi("", "")).toEqual({ connected: false, ssid: null, nameHidden: false });
});

const n = (role: string, label: string, children: AxNode[] = []) =>
    ({ role, label, value: null, x: 0, y: 0, w: 0, h: 0, focusable: false, enabled: true, children }) as AxNode;

it("reads the network name off the Wi-Fi pane: the text before \"Connected\"", () => {
    const pane = n("AXWindow", "Wi-Fi", [
        n("AXGroup", "", [
            n("AXStaticText", "Wi-Fi"),
            n("AXStaticText", "Set up Wi-Fi to wirelessly connect your Mac to the internet."),
            n("AXCheckBox", "1"),
            n("AXStaticText", "Home 5G"),
            n("AXStaticText", "Connected, Unsecured Network"),
        ]),
        n("AXHeading", "Known Network"),
    ]);
    expect(wifiNameFromPane(pane)).toBe("Home 5G");
    expect(wifiNameFromPane(n("AXWindow", "Wi-Fi", [n("AXStaticText", "Wi-Fi"), n("AXCheckBox", "0")]))).toBeNull();
});
