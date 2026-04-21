// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getMemoryDB } from "../memory/sqlite.js";

export type CalendarStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "posted" | "failed";
export type ContentType = "reel" | "post" | "story" | "carousel" | "thread" | "article" | "video" | "text";

export interface CalendarItem {
  id?: number;
  brandId: string;
  platform: string;
  contentType: ContentType;
  contentPillar?: string;
  caption?: string;
  mediaPath?: string;
  hashtags?: string[];
  scheduledAt?: string;
  status: CalendarStatus;
  postUrl?: string;
}

export function addCalendarItem(item: CalendarItem): number {
  const db = getMemoryDB();
  db.run(
    `INSERT INTO marketing_calendar (brand_id, platform, content_type, content_pillar, caption, media_path, hashtags, scheduled_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.brandId, item.platform, item.contentType, item.contentPillar ?? null,
     item.caption ?? null, item.mediaPath ?? null,
     item.hashtags ? JSON.stringify(item.hashtags) : null,
     item.scheduledAt ?? null, item.status]
  );
  const rows = db.exec("SELECT last_insert_rowid() as id");
  return Number(rows[0]?.values[0]?.[0] ?? 0);
}

export function updateCalendarItem(id: number, updates: Partial<CalendarItem>): void {
  const db = getMemoryDB();
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (updates.status !== undefined) { fields.push("status = ?"); vals.push(updates.status); }
  if (updates.caption !== undefined) { fields.push("caption = ?"); vals.push(updates.caption); }
  if (updates.mediaPath !== undefined) { fields.push("media_path = ?"); vals.push(updates.mediaPath); }
  if (updates.scheduledAt !== undefined) { fields.push("scheduled_at = ?"); vals.push(updates.scheduledAt); }
  if (updates.postUrl !== undefined) { fields.push("post_url = ?"); vals.push(updates.postUrl); }
  if (updates.hashtags !== undefined) { fields.push("hashtags = ?"); vals.push(JSON.stringify(updates.hashtags)); }
  if (!fields.length) return;
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.run(`UPDATE marketing_calendar SET ${fields.join(", ")} WHERE id = ?`, vals);
}

export function getCalendarItem(id: number): CalendarItem | null {
  const db = getMemoryDB();
  const rows = db.exec("SELECT * FROM marketing_calendar WHERE id = ?", [id]);
  if (!rows.length || !rows[0].values.length) return null;
  return rowToItem(rows[0].columns, rows[0].values[0]);
}

export function getScheduledItems(brandId: string, beforeIso: string): CalendarItem[] {
  const db = getMemoryDB();
  const rows = db.exec(
    `SELECT * FROM marketing_calendar WHERE brand_id = ? AND status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at ASC`,
    [brandId, beforeIso]
  );
  if (!rows.length) return [];
  return rows[0].values.map((v) => rowToItem(rows[0].columns, v));
}

export function getPendingApprovals(brandId: string): CalendarItem[] {
  const db = getMemoryDB();
  const rows = db.exec(
    `SELECT * FROM marketing_calendar WHERE brand_id = ? AND status = 'pending_approval' ORDER BY created_at ASC`,
    [brandId]
  );
  if (!rows.length) return [];
  return rows[0].values.map((v) => rowToItem(rows[0].columns, v));
}

function rowToItem(cols: string[], vals: unknown[]): CalendarItem {
  const obj = Object.fromEntries(cols.map((c, i) => [c, vals[i]])) as Record<string, unknown>;
  return {
    id: obj.id as number,
    brandId: obj.brand_id as string,
    platform: obj.platform as string,
    contentType: obj.content_type as ContentType,
    contentPillar: obj.content_pillar as string | undefined,
    caption: obj.caption as string | undefined,
    mediaPath: obj.media_path as string | undefined,
    hashtags: obj.hashtags ? JSON.parse(obj.hashtags as string) as string[] : undefined,
    scheduledAt: obj.scheduled_at as string | undefined,
    status: obj.status as CalendarStatus,
    postUrl: obj.post_url as string | undefined,
  };
}
