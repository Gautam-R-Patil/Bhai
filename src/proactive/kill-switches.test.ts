// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isProactiveDisabled, isSourceDisabled, isChannelDisabled, isShadowMode } from "./kill-switches.js";

describe("proactive kill switches", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("ATLAS_PROACTIVE")) delete process.env[k];
    }
  });
  afterEach(() => { process.env = { ...original }; });

  it("defaults all off", () => {
    expect(isProactiveDisabled()).toBe(false);
    expect(isSourceDisabled("memory_anticipation")).toBe(false);
    expect(isChannelDisabled("whatsapp")).toBe(false);
    expect(isShadowMode()).toBe(false);
  });

  it("respects global disable", () => {
    process.env.ATLAS_PROACTIVE_DISABLE = "true";
    expect(isProactiveDisabled()).toBe(true);
  });

  it("parses CSV source list", () => {
    process.env.ATLAS_PROACTIVE_DISABLE_SOURCES = "memory_anticipation,env_context";
    expect(isSourceDisabled("memory_anticipation")).toBe(true);
    expect(isSourceDisabled("env_context")).toBe(true);
    expect(isSourceDisabled("stale_todo")).toBe(false);
  });

  it("parses CSV channel list", () => {
    process.env.ATLAS_PROACTIVE_DISABLE_CHANNELS = "whatsapp";
    expect(isChannelDisabled("whatsapp")).toBe(true);
    expect(isChannelDisabled("telegram")).toBe(false);
  });

  it("shadow mode flag", () => {
    process.env.ATLAS_PROACTIVE_SHADOW = "true";
    expect(isShadowMode()).toBe(true);
  });
});
