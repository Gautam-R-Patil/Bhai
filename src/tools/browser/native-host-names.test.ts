// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The bridge registers its native host as com.bhai.bridge and, for extensions from before the
// rename, as com.atlas.bridge too: but never over another app's com.atlas.bridge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-native-host-"));
process.env.HOME = home;
process.env.BHAI_HOME = path.join(home, ".bhai");
process.env.BHAI_DATA_DIR = path.join(home, "data");
const ID = "a".repeat(32);
process.env.BHAI_EXTENSION_IDS = ID;
vi.mock("../../overlay/overlay-chat.js", () => ({ getOverlayLocalToken: () => "t" }));

const bridge = await import("./chrome-bridge.js");

it("lets the old name be written only when absent or Bhai's own", () => {
    const f = path.join(home, "m.json");
    expect(bridge.mayWriteLegacyManifest(f, [ID])).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ allowed_origins: [`chrome-extension://${ID}/`] }));
    expect(bridge.mayWriteLegacyManifest(f, [ID])).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ allowed_origins: [`chrome-extension://${"b".repeat(32)}/`] }));
    expect(bridge.mayWriteLegacyManifest(f, [ID])).toBe(false);
    fs.writeFileSync(f, "not json");
    expect(bridge.mayWriteLegacyManifest(f, [ID])).toBe(false);
});

it.skipIf(process.platform === "win32")("registers both names on the same host", async () => {
    const dir =
        process.platform === "darwin"
            ? path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
            : path.join(home, ".config", "google-chrome", "NativeMessagingHosts");
    bridge.initChromeBridge(20000 + Math.floor(Math.random() * 20000));
    const read = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), "utf-8"));
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, "com.atlas.bridge.json"))).toBe(true));
    const [cur, old] = [read("com.bhai.bridge"), read("com.atlas.bridge")];
    expect([cur.name, old.name]).toEqual(["com.bhai.bridge", "com.atlas.bridge"]);
    expect(old.path).toBe(cur.path);
    expect(cur.allowed_origins).toContain(`chrome-extension://${ID}/`);
    // The host reads the discovery file where the bridge writes it.
    const host = fs.readFileSync(path.join(process.env.BHAI_HOME!, "bhai-bridge-host.js"), "utf-8");
    expect(host).toContain(JSON.stringify(path.join(process.env.BHAI_HOME!, "chrome-bridge.json")));
    bridge.closeChromeBridge();
});

it("deletes the pre-rename discovery file only when it holds this bridge's token", () => {
    bridge.initChromeBridge(20000 + Math.floor(Math.random() * 20000));
    const legacy = path.join(home, ".atlas", "chrome-bridge.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ token: "another app's" }));
    bridge.removeLegacyDiscoveryFile(legacy);
    expect(fs.existsSync(legacy)).toBe(true);
    fs.writeFileSync(legacy, JSON.stringify({ token: bridge.getBridgeToken() }));
    bridge.removeLegacyDiscoveryFile(legacy);
    expect(fs.existsSync(legacy)).toBe(false);
    bridge.closeChromeBridge();
});
