// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Shared UUID v4 Generator ──────────────────
// Single implementation used across all modules.

import { randomUUID } from "node:crypto";

export function generateUUID(): string {
    return randomUUID();
}
