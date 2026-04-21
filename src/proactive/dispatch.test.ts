// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatchProactiveMessage } from "./dispatch.js";
import { registerChannelSender } from "../tools/channel-send.js";

describe("dispatchProactiveMessage", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    // Clear proactive env vars
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("ATLAS_PROACTIVE")) delete process.env[k];
    }
    // Reset senders by reregistering every channel with a silent no-op
    for (const ch of ["whatsapp","telegram","discord","slack","matrix","email","overlay"] as const) {
      registerChannelSender(ch, async () => {});
    }
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  it("routes to the registered sender for the given channel", async () => {
    const sent: string[] = [];
    registerChannelSender("whatsapp", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("whatsapp", "hello", "fyi");
    expect(sent.length).toBe(1);
  });

  it("throws on a channel with no registered sender", async () => {
    // "xmpp" is not in the Channel type — cast to test error path
    await expect(
      dispatchProactiveMessage("xmpp" as any, "x", "fyi"),
    ).rejects.toThrow(/sender|channel/i);
  });

  it("prefixes mode emoji for chat channels", async () => {
    const sent: string[] = [];
    registerChannelSender("telegram", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("telegram", "msg", "question");
    expect(sent[0].startsWith("❓ ")).toBe(true);
  });

  it("does NOT prefix for overlay", async () => {
    const sent: string[] = [];
    registerChannelSender("overlay", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("overlay", "msg", "fyi");
    expect(sent[0]).toBe("msg");
  });

  it("does NOT prefix for email", async () => {
    const sent: string[] = [];
    registerChannelSender("email", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("email", "msg", "review");
    expect(sent[0]).toBe("msg");
  });

  it("global kill switch suppresses send", async () => {
    process.env.ATLAS_PROACTIVE_DISABLE = "true";
    const sent: string[] = [];
    registerChannelSender("whatsapp", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("whatsapp", "msg", "fyi");
    expect(sent.length).toBe(0);
  });

  it("channel kill switch suppresses only that channel", async () => {
    process.env.ATLAS_PROACTIVE_DISABLE_CHANNELS = "telegram";
    const tg: string[] = [];
    const wa: string[] = [];
    registerChannelSender("telegram", async (text) => { tg.push(text); });
    registerChannelSender("whatsapp", async (text) => { wa.push(text); });
    await dispatchProactiveMessage("telegram", "msg", "fyi");
    await dispatchProactiveMessage("whatsapp", "msg", "fyi");
    expect(tg.length).toBe(0);
    expect(wa.length).toBe(1);
  });

  it("shadow mode logs but does not send", async () => {
    process.env.ATLAS_PROACTIVE_SHADOW = "true";
    const sent: string[] = [];
    registerChannelSender("whatsapp", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("whatsapp", "msg", "fyi");
    expect(sent.length).toBe(0);
  });
});
