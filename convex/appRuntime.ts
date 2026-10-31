// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Server-side runtime key derivation for Bhai desktop app.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { bhaiEnv } from "./envCompat";

/**
 * Derive a per-installation runtime key.
 * Key = HMAC-SHA256(BHAI_RUNTIME_MASTER_SECRET, deviceFingerprint || otplessUserId)
 * Returns the key as a hex string (64 chars).
 */
export const deriveRuntimeKey = internalAction({
  args: {
    otplessUserId: v.string(),
    deviceFingerprint: v.optional(v.string()),
  },
  handler: async (_ctx, { otplessUserId, deviceFingerprint }): Promise<string> => {
    // If BHAI_RUNTIME_MASTER_SECRET is ever set it must equal the ATLAS_ value,
    // or every install's runtime key changes.
    const masterSecret = bhaiEnv("RUNTIME_MASTER_SECRET");
    if (!masterSecret) {
      throw new Error("BHAI_RUNTIME_MASTER_SECRET not configured");
    }

    const bindingMaterial = deviceFingerprint || otplessUserId;

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(masterSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      keyMaterial,
      enc.encode(bindingMaterial),
    );

    return Array.from(new Uint8Array(signature), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  },
});
