// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { deliverToActiveChannel, getActiveChannel } from "../tools/channel-send.js";
import { updateCalendarItem } from "./content-calendar.js";

export interface ApprovalRequest {
  itemId: number;
  brandId: string;
  platform: string;
  contentType: string;
  caption: string;
  mediaPath?: string;
  scheduledAt?: string;
}

const pendingApprovals = new Map<number, ApprovalRequest>();

export function queueApproval(req: ApprovalRequest): void {
  pendingApprovals.set(req.itemId, req);
  updateCalendarItem(req.itemId, { status: "pending_approval" });
}

export async function sendApprovalRequest(req: ApprovalRequest): Promise<void> {
  const channel = getActiveChannel() ?? "telegram";
  const msg = buildApprovalMessage(req, channel);
  await deliverToActiveChannel(msg, req.mediaPath ?? "");
}

export function resolveApproval(itemId: number, approved: boolean): void {
  const req = pendingApprovals.get(itemId);
  if (!req) return;
  pendingApprovals.delete(itemId);
  updateCalendarItem(itemId, { status: approved ? "approved" : "draft" });
}

export function getPendingApprovalByItemId(itemId: number): ApprovalRequest | undefined {
  return pendingApprovals.get(itemId);
}

function buildApprovalMessage(req: ApprovalRequest, channel: string): string {
  const when = req.scheduledAt
    ? `Scheduled for ${new Date(req.scheduledAt).toLocaleString()}`
    : "Ready to post";

  if (channel === "whatsapp") {
    return [
      `📱 *Content Ready for Approval* (ID: ${req.itemId})`,
      `Platform: ${req.platform} | Type: ${req.contentType}`,
      `${when}`,
      ``,
      `Caption: ${req.caption}`,
      ``,
      `Reply: *approve ${req.itemId}* or *reject ${req.itemId}: your feedback*`,
    ].join("\n");
  }

  if (channel === "slack") {
    return [
      `*Content Ready for Approval* (ID: \`${req.itemId}\`)`,
      `*Platform:* ${req.platform} | *Type:* ${req.contentType} | ${when}`,
      `*Caption:* ${req.caption}`,
      `Reply: \`approve ${req.itemId}\` or \`reject ${req.itemId}: feedback\``,
    ].join("\n");
  }

  return [
    `**Content Ready for Approval** (ID: \`${req.itemId}\`)`,
    `**Platform:** ${req.platform} | **Type:** ${req.contentType}`,
    `**${when}**`,
    ``,
    `**Caption:** ${req.caption}`,
    ``,
    `Reply: \`approve ${req.itemId}\` or \`reject ${req.itemId}: your feedback\``,
  ].join("\n");
}
