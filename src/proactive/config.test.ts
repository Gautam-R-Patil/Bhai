// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProactiveConfig, getPosture, setPosture, type ProactiveConfig } from "./config.js";

describe("proactive config", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atlas-proactive-"));
    file = join(dir, "proactive-config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns defaults when file missing", () => {
    const c = loadProactiveConfig(file);
    expect(c.postures.whatsapp).toBe("calm");
    expect(c.postures.telegram).toBe("active");
    expect(c.postures.overlay).toBe("ambient");
  });

  it("reads + persists posture changes", () => {
    const c = loadProactiveConfig(file);
    setPosture(c, "whatsapp", "ambient", file);
    const reloaded = loadProactiveConfig(file);
    expect(reloaded.postures.whatsapp).toBe("ambient");
    expect(getPosture(reloaded, "whatsapp")).toBe("ambient");
  });

  it("rejects unknown channel", () => {
    const c = loadProactiveConfig(file);
    expect(() => setPosture(c, "xmpp" as any, "calm", file)).toThrow(/channel/i);
  });

  it("rejects unknown preset", () => {
    const c = loadProactiveConfig(file);
    expect(() => setPosture(c, "whatsapp", "spammy" as any, file)).toThrow(/preset/i);
  });

  it("merges partial user config with defaults", () => {
    writeFileSync(file, JSON.stringify({ postures: { slack: "active" } }));
    const c: ProactiveConfig = loadProactiveConfig(file);
    expect(c.postures.slack).toBe("active");          // user override
    expect(c.postures.whatsapp).toBe("calm");         // default preserved
    expect(c.postures.telegram).toBe("active");       // default preserved
    expect(c.urgentAllowedAfter).toBe("07:00");       // default preserved
  });
});
