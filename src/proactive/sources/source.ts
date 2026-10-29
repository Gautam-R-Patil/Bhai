// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ProactiveIntent, IntentSource } from "../intent.js";

export type SourceCtx = {
    now: number;
};

export interface IntentSourceModule {
    name: IntentSource;
    collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]>;
    /** The intent reached the owner (not suppressed); one-shot sources record it here. */
    onDispatched?(intent: ProactiveIntent): void;
}
