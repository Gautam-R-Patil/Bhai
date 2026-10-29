// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// The per-step status line a long turn shows ("step 3 · 🌐 Opening x · 42s")
// and the heartbeat that keeps it fresh while one tool batch runs long.

export const STEP_HEARTBEAT_MS = 20_000;

export function formatStepStatus(step: number, status: string, elapsedMs: number): string {
    return `step ${step} · ${status.trim()} · ${Math.max(0, Math.round(elapsedMs / 1000))}s`;
}

/**
 * Tools that stream their own progress through the channel callback
 * (setSwarmProgress & co.), which the agent's quiet-timer never sees. A batch
 * running one gets no heartbeat, so filler never overwrites their real status.
 */
export const SELF_REPORTING_TOOLS = new Set(["swarm_task", "deep_research", "start_long_task", "resume_long_task"]);

const STEP_LINE = /^step (\d+) · (.+) · (\d+)s$/s;

export function parseStepLine(msg: string): { step: number; status: string; elapsedMs: number } | null {
    const m = STEP_LINE.exec(msg);
    return m ? { step: Number(m[1]), status: m[2], elapsedMs: Number(m[3]) * 1000 } : null;
}

/**
 * Rewrite only the status part of a step line (channels humanize or trim the
 * status and keep the step + elapsed). Other messages go through `fn` whole.
 */
export function mapStepStatus<T extends string | null>(msg: string, fn: (status: string) => T): T {
    const line = parseStepLine(msg);
    if (!line) return fn(msg);
    const status = fn(line.status);
    return (status === null ? null : formatStepStatus(line.step, status, line.elapsedMs)) as T;
}

/**
 * Calls `resend` every `everyMs` the batch has gone quiet: nothing sent since
 * it started or since `lastSentAt()`. Returns the stop function.
 */
export function startStepHeartbeat(
    lastSentAt: () => number,
    resend: () => void,
    everyMs = STEP_HEARTBEAT_MS,
): () => void {
    const startedAt = Date.now();
    const timer = setInterval(
        () => {
            if (Date.now() - Math.max(startedAt, lastSentAt()) >= everyMs) resend();
        },
        Math.max(1, Math.floor(everyMs / 4)),
    );
    timer.unref?.();
    return () => clearInterval(timer);
}
