// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { validateIntent, makeIntentId, type ProactiveIntent } from "./intent.js";

describe("ProactiveIntent", () => {
  it("validates a well-formed intent", () => {
    const intent: ProactiveIntent = {
      id: "test-1",
      source: "memory_anticipation",
      mode: "fyi",
      urgency: "normal",
      channelPreference: "any",
      topic: "sample",
      topicEmbedding: new Array(384).fill(0),
      evidence: [],
      payload: { kind: "simple_note", note: "hi" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    expect(validateIntent(intent).ok).toBe(true);
  });

  it("rejects intent with wrong embedding length", () => {
    const intent: ProactiveIntent = {
      id: "test-2",
      source: "memory_anticipation",
      mode: "fyi",
      urgency: "normal",
      channelPreference: "any",
      topic: "sample",
      topicEmbedding: [0, 0, 0],
      evidence: [],
      payload: { kind: "simple_note" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const r = validateIntent(intent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/embedding/i);
  });

  it("generates unique intent ids", () => {
    const a = makeIntentId("memory_anticipation");
    const b = makeIntentId("memory_anticipation");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^memory_anticipation_/);
  });

  it("rejects review mode without suggestedAction", () => {
    const intent: ProactiveIntent = {
      id: "rev-1",
      source: "meeting_followup",
      mode: "review",
      urgency: "normal",
      channelPreference: "overlay",
      topic: "follow up",
      topicEmbedding: new Array(384).fill(0),
      evidence: [],
      payload: { kind: "meeting_followup" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const r = validateIntent(intent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/suggestedAction/i);
  });

  it("accepts review mode with suggestedAction", () => {
    const intent: ProactiveIntent = {
      id: "rev-2",
      source: "meeting_followup",
      mode: "review",
      urgency: "normal",
      channelPreference: "overlay",
      topic: "follow up",
      topicEmbedding: new Array(384).fill(0),
      evidence: [],
      payload: { kind: "meeting_followup" },
      suggestedAction: { toolCalls: [], summary: "draft recap email" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    expect(validateIntent(intent).ok).toBe(true);
  });
});
