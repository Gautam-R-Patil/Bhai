// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// ATLAS → BHAI rename: the live deployment and old clients still use the old
// names, so each renamed name falls back to (or keeps writing) the old one.
import { afterEach, describe, expect, it } from "vitest";
import { bhaiEnv } from "./envCompat";
import { create as createItem, update as updateItem } from "./store/items";
import { approve as approveSubmission, create as createSubmission } from "./store/submissions";

type Handler = { _handler: (c: unknown, a: unknown) => Promise<unknown> };
const run = (fn: unknown, ctx: unknown, args: unknown) => (fn as Handler)._handler(ctx, args);

describe("bhaiEnv", () => {
  afterEach(() => {
    delete process.env.BHAI_RENAME_TEST;
    delete process.env.ATLAS_RENAME_TEST;
  });
  it("prefers BHAI_, falls back to ATLAS_", () => {
    expect(bhaiEnv("RENAME_TEST")).toBeUndefined();
    process.env.ATLAS_RENAME_TEST = "old";
    expect(bhaiEnv("RENAME_TEST")).toBe("old");
    process.env.BHAI_RENAME_TEST = "new";
    expect(bhaiEnv("RENAME_TEST")).toBe("new");
  });
});

describe("store minBhaiVersion / minAtlasVersion", () => {
  function fakeCtx(existing: Record<string, unknown> = {}) {
    const rows: Record<string, unknown>[] = [];
    const patches: Record<string, unknown>[] = [];
    const db = {
      get: async () => ({ status: "approved", totalApps: 0, developerId: "d1", ...existing }),
      insert: async (_t: string, row: Record<string, unknown>) => { rows.push(row); return "id1"; },
      patch: async (_id: string, f: Record<string, unknown>) => { patches.push(f); },
      query: () => ({ withIndex: () => ({ first: async () => null }), filter: () => ({ first: async () => null }) }),
    };
    return { ctx: { db }, rows, patches };
  }
  const item = { slug: "s", type: "skill", name: "n", description: "d", developerId: "d1", version: "1.0.0", contentFileId: "f", category: "c", tags: [], permissions: [], pricing: "free" };

  it("an old client's minAtlasVersion is stored under both names", async () => {
    const { ctx, rows } = fakeCtx();
    await run(createItem, ctx, { ...item, minAtlasVersion: "0.2.0" });
    expect(rows[0]).toMatchObject({ minBhaiVersion: "0.2.0", minAtlasVersion: "0.2.0" });
  });

  it("a new client's minBhaiVersion is stored under both names", async () => {
    const { ctx, rows } = fakeCtx();
    await run(createSubmission, ctx, { ...item, isUpdate: false, minBhaiVersion: "0.3.0" });
    expect(rows[0]).toMatchObject({ minBhaiVersion: "0.3.0", minAtlasVersion: "0.3.0" });
  });

  it("approving a submission from before the rename carries its minAtlasVersion over under both names", async () => {
    const created = fakeCtx({ ...item, isUpdate: false, minAtlasVersion: "0.1.9" });
    await run(approveSubmission, created.ctx, { submissionId: "s1", adminId: "a1" });
    expect(created.rows[0]).toMatchObject({ minBhaiVersion: "0.1.9", minAtlasVersion: "0.1.9" });
    const updated = fakeCtx({ ...item, isUpdate: true, existingItemId: "i1", minAtlasVersion: "0.1.9" });
    await run(approveSubmission, updated.ctx, { submissionId: "s1", adminId: "a1" });
    expect(updated.patches[1]).toMatchObject({ minBhaiVersion: "0.1.9", minAtlasVersion: "0.1.9" });
  });

  it("an update without either name leaves the stored value alone", async () => {
    const { ctx, patches } = fakeCtx();
    await run(updateItem, ctx, { itemId: "i1", version: "1.0.1" });
    expect(patches[0]).not.toHaveProperty("minBhaiVersion");
    expect(patches[0]).not.toHaveProperty("minAtlasVersion");
    await run(updateItem, ctx, { itemId: "i1", version: "1.0.2", minAtlasVersion: "0.2.1" });
    expect(patches[1]).toMatchObject({ minBhaiVersion: "0.2.1", minAtlasVersion: "0.2.1" });
  });
});
