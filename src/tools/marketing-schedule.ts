// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { updateCalendarItem, getScheduledItems, getCalendarItem } from "../marketing/content-calendar.js";
import { scheduleTask } from "./scheduled.js";

export const marketingSchedule: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "marketing_schedule",
      description: "Schedule a content calendar item for posting, list upcoming scheduled posts, or cancel a scheduled post.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["schedule", "list", "cancel"] },
          brand_id: { type: "string" },
          item_id: { type: "number" },
          scheduled_at: { type: "string" },
        },
        required: ["action", "brand_id"],
      },
    },
  },
  async handler(input) {
    const action = input.action as string;
    const brandId = input.brand_id as string;
    const itemId = input.item_id as number | undefined;
    const scheduledAt = input.scheduled_at as string | undefined;

    if (action === "schedule") {
      if (!itemId || !scheduledAt) {
        return JSON.stringify({ error: "item_id and scheduled_at are required for schedule action" });
      }
      const item = getCalendarItem(itemId);
      if (!item) return JSON.stringify({ error: `Calendar item ${itemId} not found` });

      updateCalendarItem(itemId, { status: "scheduled", scheduledAt });

      const dt = new Date(scheduledAt);
      // Use the specific date + time — the trigger handler detects the JSON action and stops the cron after firing
      const cronExpr = `${dt.getMinutes()} ${dt.getHours()} ${dt.getDate()} ${dt.getMonth() + 1} *`;

      // Encode full post params as JSON so the trigger handler can call social_post directly
      const actionPayload = JSON.stringify({
        __marketing_post: true,
        brandId,
        itemId,
        platform: item.platform,
        contentType: item.contentType,
        caption: item.caption ?? "",
        mediaPath: item.mediaPath,
        hashtags: item.hashtags ?? [],
      });

      const scheduleResult = await scheduleTask.handler({
        expression: cronExpr,
        description: `Post calendar item ${itemId} for brand ${brandId} on ${scheduledAt}`,
        action: actionPayload,
      });

      return JSON.stringify({
        success: true,
        itemId,
        scheduledAt,
        cronExpression: cronExpr,
        scheduleResult: JSON.parse(scheduleResult),
      });
    }

    if (action === "list") {
      const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const items = getScheduledItems(brandId, until);
      if (!items.length) return JSON.stringify({ items: [], message: "No scheduled posts in the next 30 days" });
      const formatted = items.map((item) => ({
        id: item.id,
        platform: item.platform,
        type: item.contentType,
        scheduledAt: item.scheduledAt,
        caption: (item.caption?.slice(0, 80) ?? "") + (item.caption && item.caption.length > 80 ? "…" : ""),
        status: item.status,
      }));
      return JSON.stringify({ items: formatted, count: items.length });
    }

    if (action === "cancel") {
      if (!itemId) return JSON.stringify({ error: "item_id required for cancel" });
      updateCalendarItem(itemId, { status: "draft" });
      return JSON.stringify({ success: true, message: `Item ${itemId} moved back to draft — not scheduled` });
    }

    return JSON.stringify({ error: `Unknown action: ${action}` });
  },
};
