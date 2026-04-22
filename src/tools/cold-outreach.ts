// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { runOutreachCampaign } from "../marketing/outreach-engine.js";

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
  async handler(input) {
    try {
      const result = await runOutreachCampaign({
        brandId: input.brand_id as string,
        channel: input.channel as "email" | "linkedin" | "twitter",
        targetDescription: input.target_description as string,
        messageTemplate: input.message_template as string,
        maxLeads: (input.max_leads as number) ?? 10,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
  },
};
