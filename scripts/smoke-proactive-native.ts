// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import * as native from "../native/index.js";
const n = native as any;
console.log("monitor:", n.proactiveMonitorPing?.());
console.log("validate:", n.validateIntentRust?.({
  id: "x",
  source: "memory_anticipation",
  mode: "fyi",
  urgency: "normal",
  channelPreference: "any",
  topic: "t",
  topicEmbedding: new Array(384).fill(0),
  payloadKind: "k",
  hasSuggestedAction: false,
  createdAt: 1,
  expiresAt: 2,
}));

// Negative case — review mode without suggestedAction should be rejected
console.log("validate-rev:", n.validateIntentRust?.({
  id: "y",
  source: "meeting_followup",
  mode: "review",
  urgency: "normal",
  channelPreference: "overlay",
  topic: "t",
  topicEmbedding: new Array(384).fill(0),
  payloadKind: "k",
  hasSuggestedAction: false,
  createdAt: 1,
  expiresAt: 2,
}));
