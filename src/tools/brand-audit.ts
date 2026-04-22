// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import type { LLMClient } from "../llm.js";
import { runBrandAudit } from "../marketing/brand-audit.js";
import type { Platform } from "../marketing/brand-profile.js";

let _llm: LLMClient | null = null;
export function setBrandAuditLLM(llm: LLMClient): void { _llm = llm; }

export const brandAudit: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "brand_audit",
      description: "Audit a brand's online presence: scrape website, analyse existing social profiles, research competitors, extract brand voice. Returns a structured report.",
      parameters: {
        type: "object",
        properties: {
          brand_id: { type: "string" },
          website: { type: "string" },
          social_handles: { type: "object" },
          competitors: { type: "array", items: { type: "string" } },
          depth: { type: "string", enum: ["quick", "standard", "deep"] },
        },
        required: ["brand_id", "website"],
      },
    },
  },
  async handler(input) {
    if (!_llm) return JSON.stringify({ error: "Brand audit LLM not initialised — call setBrandAuditLLM at boot" });
    try {
      const report = await runBrandAudit(
        {
          brandId: input.brand_id as string,
          website: input.website as string,
          socialHandles: (input.social_handles as Partial<Record<Platform, string>>) ?? {},
          competitors: (input.competitors as string[]) ?? [],
          depth: (input.depth as "quick" | "standard" | "deep") ?? "standard",
        },
        _llm
      );
      return JSON.stringify(report);
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.toLowerCase().includes("credential") ||
        msg.toLowerCase().includes("not set") ||
        msg.toLowerCase().includes("missing")
      ) {
        return JSON.stringify({
          error: msg,
          action_required: "credential_setup",
          hint: `A platform credential is missing for brand "${input.brand_id as string}". Call credential_setup with the appropriate platform and brand_id to set up the missing credentials, then retry brand_audit.`,
        });
      }
      return JSON.stringify({ error: msg });
    }
  },
};
