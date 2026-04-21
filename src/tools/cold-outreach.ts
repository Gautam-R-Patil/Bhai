// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

export const coldOutreach: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "cold_outreach",
      description: "Find leads and send personalised cold outreach via email or LinkedIn. For LinkedIn, presents risk options to the user before sending.",
      parameters: {
        type: "object",
        properties: {
          brand_id: { type: "string" },
          channel: { type: "string", enum: ["email", "linkedin", "twitter"] },
          target_description: { type: "string" },
          message_template: { type: "string" },
          max_leads: { type: "number" },
        },
        required: ["brand_id", "channel", "target_description", "message_template"],
      },
    },
  },
  async handler(_input) {
    return JSON.stringify({ status: "stub", message: "cold_outreach not yet implemented — Plan 4" });
  },
};
