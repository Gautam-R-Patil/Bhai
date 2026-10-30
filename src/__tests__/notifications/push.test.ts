// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// First boot (no vapid-keys.json): the VAPID public key is ready as soon as
// initPushNotifications() is called, without loading web-push.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => [] as string[]);
vi.mock("web-push", () => { loaded.push("web-push"); return { default: {} }; });

it("generates valid VAPID keys synchronously on first boot", async () => {
    vi.stubEnv("ATLAS_DATA_DIR", mkdtempSync(join(tmpdir(), "push-test-")));
    const push = await import("../../notifications/push.js");

    const done = push.initPushNotifications(); // not awaited, as in overlay-chat.ts
    const pub = push.getVapidPublicKey();
    expect(pub).not.toBeNull();
    await done;
    expect(loaded).toEqual([]);

    // Keys must be accepted by web-push itself.
    const { createRequire } = await import("node:module");
    const helper = createRequire(import.meta.url)("web-push/src/vapid-helper.js");
    const keys = JSON.parse((await import("node:fs")).readFileSync(join(process.env.ATLAS_DATA_DIR as string, "vapid-keys.json"), "utf8"));
    expect(keys.publicKey).toBe(pub);
    expect(() => helper.validatePublicKey(keys.publicKey)).not.toThrow();
    expect(() => helper.validatePrivateKey(keys.privateKey)).not.toThrow();
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
});
