// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "./sqlite.js";

describe("proactive subsystem migrations", () => {
  function freshDb() {
    const raw = new BetterSqlite3(":memory:");
    const db = wrapDatabase(raw);
    initProactiveSchema(db);
    return raw;
  }

  it("creates monitor_rules table", () => {
    const db = freshDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_rules'").get() as { name?: string } | undefined;
    expect(row?.name).toBe("monitor_rules");
  });

  it("creates inbox_items table with status index", () => {
    const db = freshDb();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_items'").get() as { name?: string } | undefined;
    expect(t?.name).toBe("inbox_items");
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_status'").get() as { name?: string } | undefined;
    expect(idx?.name).toBe("idx_inbox_status");
  });

  it("creates proactive_outcomes table with source/channel index", () => {
    const db = freshDb();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proactive_outcomes'").get() as { name?: string } | undefined;
    expect(t?.name).toBe("proactive_outcomes");
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_outcomes_source_channel'").get() as { name?: string } | undefined;
    expect(idx?.name).toBe("idx_outcomes_source_channel");
  });
});
