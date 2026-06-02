// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Scheduled background jobs. Convex picks this file up automatically — no
// manual deploy step beyond `npx convex deploy`.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 30-day retention on the per-call LLM log and the generic error log.
// Both deletes are bounded (500 rows per run) so a backlog after a long
// outage doesn't blow past the mutation row limit — the sweep runs daily
// and chews through stale rows over multiple nights if needed.
crons.daily(
    "sweep llm_call_log",
    { hourUTC: 4, minuteUTC: 15 },
    internal.llmCallLog.sweepOld,
    {},
);

crons.daily(
    "sweep error_log",
    { hourUTC: 4, minuteUTC: 30 },
    internal.errorLog.sweepOld,
    {},
);

crons.daily(
    "sweep sessions+rate_limits",
    { hourUTC: 4, minuteUTC: 45 },
    internal.sessions.sweepExpired,
    {},
);

// Retire never-used user prompt addenda (hits === 0, stale). Self-gates on the
// ATLAS_ADDENDA_HITS deployment flag — a no-op until hit-tracking is enabled,
// so it can never retire addenda whose hits simply weren't being counted.
crons.daily(
    "sweep stale user addenda",
    { hourUTC: 5, minuteUTC: 0 },
    internal.userAddenda.sweepAllStaleAddenda,
    {},
);

export default crons;
