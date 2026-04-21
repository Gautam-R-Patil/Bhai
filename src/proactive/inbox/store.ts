// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// InboxStore — SQLite persistence for review-mode intents awaiting user action.
// Phase 4.1 of the proactive overhaul.

import type Database from "better-sqlite3";
import type { ProactiveIntent } from "../intent.js";

export type InboxStatus = "pending" | "approved" | "rejected" | "deferred" | "expired";
export type InboxUserAction = "approve" | "reject" | "defer" | "edit";
export type InboxExecutionStatus = "idle" | "running" | "done" | "failed";

export type InboxItem = {
    intent: ProactiveIntent;
    status: InboxStatus;
    composedText: string;
    createdAt: number;
    userActionAt?: number;
    userAction?: InboxUserAction;
    editedText?: string;
    executionStatus?: InboxExecutionStatus;
    executionResult?: string;
    deferredUntil?: number;
};

export type InboxItemPatch = Partial<
    Pick<InboxItem, "status" | "userActionAt" | "userAction" | "editedText" | "executionStatus" | "executionResult" | "deferredUntil">
>;

type Row = {
    intent_id: string;
    intent_json: string;
    status: string;
    composed_text: string;
    created_at: number;
    user_action_at: number | null;
    user_action: string | null;
    edited_text: string | null;
    execution_status: string | null;
    execution_result: string | null;
    deferred_until: number | null;
};

export class InboxStore {
    constructor(private db: Database.Database) {}

    /** Add a new pending item. Overwrites if the intent.id already exists (shouldn't happen — intent ids are unique). */
    add(item: { intent: ProactiveIntent; composedText: string }): InboxItem {
        const full: InboxItem = {
            intent: item.intent,
            status: "pending",
            composedText: item.composedText,
            createdAt: Date.now(),
        };
        this.db
            .prepare(
                `INSERT OR REPLACE INTO inbox_items (
                    intent_id, intent_json, status, composed_text, created_at,
                    user_action_at, user_action, edited_text,
                    execution_status, execution_result, deferred_until
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                full.intent.id,
                JSON.stringify(full.intent),
                full.status,
                full.composedText,
                full.createdAt,
                null, null, null, null, null, null,
            );
        return full;
    }

    get(id: string): InboxItem | null {
        const row = this.db.prepare(`SELECT * FROM inbox_items WHERE intent_id = ?`).get(id) as Row | undefined;
        return row ? rowToItem(row) : null;
    }

    /** Pending items, newest first. */
    listPending(): InboxItem[] {
        const rows = this.db
            .prepare(`SELECT * FROM inbox_items WHERE status = 'pending' ORDER BY created_at DESC`)
            .all() as Row[];
        return rows.map(rowToItem);
    }

    /** All items (including history). Optionally filtered by status. Newest first. */
    listAll(status?: InboxStatus): InboxItem[] {
        const rows = status
            ? this.db.prepare(`SELECT * FROM inbox_items WHERE status = ? ORDER BY created_at DESC`).all(status) as Row[]
            : this.db.prepare(`SELECT * FROM inbox_items ORDER BY created_at DESC`).all() as Row[];
        return rows.map(rowToItem);
    }

    /** Apply a partial update. Returns the updated item, or null if not found. */
    update(id: string, patch: InboxItemPatch): InboxItem | null {
        const existing = this.get(id);
        if (!existing) return null;
        const merged: InboxItem = { ...existing, ...patch };
        this.db
            .prepare(
                `UPDATE inbox_items SET
                    status = ?, user_action_at = ?, user_action = ?, edited_text = ?,
                    execution_status = ?, execution_result = ?, deferred_until = ?
                 WHERE intent_id = ?`,
            )
            .run(
                merged.status,
                merged.userActionAt ?? null,
                merged.userAction ?? null,
                merged.editedText ?? null,
                merged.executionStatus ?? null,
                merged.executionResult ?? null,
                merged.deferredUntil ?? null,
                id,
            );
        return merged;
    }

    /** Mark pending items older than `olderThanMs` (in ms-since-epoch) as expired. Returns count. */
    expireOld(olderThanMs: number): number {
        const result = this.db
            .prepare(`UPDATE inbox_items SET status = 'expired' WHERE status = 'pending' AND created_at < ?`)
            .run(olderThanMs);
        return result.changes;
    }

    /** Remove a row entirely. Used in tests + admin cleanup. */
    hardDelete(id: string): void {
        this.db.prepare(`DELETE FROM inbox_items WHERE intent_id = ?`).run(id);
    }
}

function rowToItem(row: Row): InboxItem {
    const intent = JSON.parse(row.intent_json) as ProactiveIntent;
    return {
        intent,
        status: row.status as InboxStatus,
        composedText: row.composed_text,
        createdAt: row.created_at,
        userActionAt: row.user_action_at ?? undefined,
        userAction: (row.user_action ?? undefined) as InboxUserAction | undefined,
        editedText: row.edited_text ?? undefined,
        executionStatus: (row.execution_status ?? undefined) as InboxExecutionStatus | undefined,
        executionResult: row.execution_result ?? undefined,
        deferredUntil: row.deferred_until ?? undefined,
    };
}
