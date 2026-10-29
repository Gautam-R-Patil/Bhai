// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Heartbeat System ──────────────────────────
// Periodic check-ins + proactive notifications with activity awareness

import { getTimeContext } from "../alive-ux.js";
import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { getTimezone } from "../location/index.js";
import { getEpisodicSnippet } from "../memory/episodic.js";
import { getIdentityPromptSnippet } from "../memory/identity.js";
import { getSessionSummary } from "../memory/session.js";
import { getCoreMemory } from "../memory/sqlite.js";
import { getUnrespondedProactiveTopics } from "../telegram.js";
import { describePresence, getUserPresence, type UserPresence } from "./activity.js";
import { globalBoundaryBus } from "./boundary-events.js";
import { shouldSuppressMessage } from "./dnd.js";
import { initInnerThoughts, tick as innerThoughtsTick, recordUserEngagement } from "./inner-thoughts.js";
import { buildAlertMessage, runAllMonitors } from "./monitors.js";
import { getEstimatedWakeTime } from "./notification-tracker.js";

// ── Types ─────────────────────────────────────

interface HeartbeatConfig {
    intervalMs: number;
    onNotification: (message: string) => Promise<void>;
}

// ── State ─────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let config: HeartbeatConfig | null = null;
let checkCount = 0;
let briefingSentDate = ""; // YYYY-MM-DD — which day we already sent the briefing
let briefingTargetMinute = -1; // minutes-since-midnight (local tz) randomly chosen for today

export function pickBriefingTime(): number {
    const low = 6 * 60;
    const high = 10 * 60;
    const est = getEstimatedWakeTime();
    if (est && est.confidence >= 0.5) {
        const candidate = Math.round(est.meanHour * 60) + 5;
        return Math.max(low, Math.min(high, candidate));
    }
    return low + Math.floor(Math.random() * (high - low));
}

export function maybeEmitMorningBoundary(params: {
    minutesNow: number;
    todayStr: string;
    inWindow: boolean;
    targetMinute: number;
}): boolean {
    const { minutesNow, todayStr, inWindow, targetMinute } = params;
    if (process.env.ATLAS_PROACTIVE_V3_SOURCES === "false") return false;
    if (briefingSentDate === todayStr) return false;

    const primary = inWindow && targetMinute !== -1 && minutesNow >= targetMinute;
    const catchUp = !inWindow && minutesNow > 10 * 60 && minutesNow < 14 * 60;

    if (!primary && !catchUp) return false;

    briefingSentDate = todayStr;
    briefingTargetMinute = -1;
    globalBoundaryBus.emit({ kind: "morning_window", ts: Date.now() });
    console.log(
        primary
            ? "💓 Morning window boundary emitted (V3 path)"
            : "💓 Missed morning window — emitting catch-up boundary",
    );
    return true;
}

export function _resetBriefingStateForTests(): void {
    briefingSentDate = "";
    briefingTargetMinute = -1;
}

// ── Start ─────────────────────────────────────

export function startHeartbeat(llm: LLMClient, cfg: HeartbeatConfig): void {
    config = cfg;

    if (process.env.ATLAS_PROACTIVE_FORCE_MORNING === "true" && process.env.ATLAS_PROACTIVE_V3_SOURCES !== "false") {
        console.log("💓 ATLAS_PROACTIVE_FORCE_MORNING — emitting morning_window boundary now");
        setTimeout(() => {
            globalBoundaryBus.emit({ kind: "morning_window", ts: Date.now() });
        }, 1000);
    }

    heartbeatTimer = setInterval(async () => {
        checkCount++;
        console.log(`💓 Heartbeat #${checkCount}`);

        try {
            // ── Network health guard: skip LLM/network operations when offline ──
            try {
                const { isOffline, shouldNotifyUser, getOfflineNotificationMessage, getNetworkStatus } = await import(
                    "../network-health.js"
                );
                if (isOffline()) {
                    console.log(`💓 Heartbeat skipping — internet offline`);
                    // Notify user once about the outage via overlay
                    if (shouldNotifyUser()) {
                        try {
                            const { sendOverlayNotification } = await import("../overlay/overlay-chat.js");
                            sendOverlayNotification(getOfflineNotificationMessage());
                        } catch {
                            /* overlay not initialized */
                        }
                    }
                    return; // Skip entire heartbeat tick
                }
                if (getNetworkStatus() === "degraded") {
                    console.log(`💓 Heartbeat running in degraded mode — skipping non-essential operations`);
                }
            } catch {
                /* network monitor not loaded yet — continue normally */
            }

            // Use detected timezone for all time logic
            const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: getTimezone() }));
            const todayStr = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
            const minutesNow = nowLocal.getHours() * 60 + nowLocal.getMinutes();
            const hourNow = nowLocal.getHours();

            // ── Morning Briefing Logic (unchanged) ──

            // Each new day, pick a fresh random send-time for the briefing
            if (briefingSentDate !== todayStr && minutesNow < 6 * 60) {
                briefingTargetMinute = -1;
            }
            if (briefingTargetMinute === -1 && minutesNow >= 6 * 60) {
                briefingTargetMinute = pickBriefingTime();
                console.log(
                    `💓 Morning briefing scheduled for ${Math.floor(briefingTargetMinute / 60)}:${String(briefingTargetMinute % 60).padStart(2, "0")} (${getTimezone()}) today`,
                );
            }

            const inWindow = minutesNow >= 6 * 60 && minutesNow <= 10 * 60;

            maybeEmitMorningBoundary({
                minutesNow,
                todayStr,
                inWindow,
                targetMinute: briefingTargetMinute,
            });

            // ── Night Dreaming Check ──
            // Check if conditions are right for automated dreaming (user asleep, night hours)
            try {
                const { checkDreamingConditions } = await import("./dreaming.js");
                let sessionSummary = "";
                try {
                    sessionSummary = getSessionSummary() || "";
                } catch {
                    /* */
                }
                await checkDreamingConditions(llm, sessionSummary);
            } catch {
                // Dreaming module not loaded — skip
            }

            // ── Proactive Monitors (zero LLM tokens) ──

            // Get laptop activity snapshot (needed for both monitors and proactive check)
            const presence = await getUserPresence();

            // Run all lightweight monitors in parallel (~50ms, 0 tokens)
            const monitorResults = await runAllMonitors(presence.frontmostApp);
            const alertMsg = buildAlertMessage(monitorResults);

            if (alertMsg && config?.onNotification) {
                // Gate through Smart DND (important alerts like reminders/calendar bypass)
                const suppress = await shouldSuppressMessage(alertMsg);
                if (!suppress) {
                    console.log(`💓 Monitor alert fired`);
                    await config.onNotification(alertMsg); // the sender records the delivery (once)
                } else {
                    console.log(`💓 Monitor alert suppressed by DND`);
                }
            }

            // ── Inner Thoughts Engine (replaces old every-6th-tick proactive check) ──
            // Runs every tick but decides internally whether to surface a thought
            // based on multi-signal trigger detection and adaptive scoring.

            try {
                const thought = await innerThoughtsTick({
                    presence,
                    monitorAlerts: alertMsg,
                    hourNow,
                });

                if (thought && config?.onNotification) {
                    // Score through proactive reward model before surfacing
                    let shouldSurface = true;
                    try {
                        const { scoreProactiveAction } = await import("./proactive-reward.js");
                        const rewardScore = await scoreProactiveAction(llm, thought, {
                            userActiveApp: presence.frontmostApp,
                            userIdleMinutes: presence.idleMinutes,
                            hourOfDay: hourNow,
                        });
                        // Set before logging: the log line used to throw first, so a
                        // suppressed thought went out anyway. ("queue" still surfaces —
                        // the heuristic fallback never says "surface" and there is no queue.)
                        shouldSurface = rewardScore.recommendation !== "suppress";
                        if (rewardScore.recommendation === "suppress") {
                            console.log(
                                `💓 Inner thought suppressed by reward model (acceptance: ${rewardScore.acceptanceProbability.toFixed(2)})`,
                            );
                        } else {
                            console.log(
                                `💓 Inner thought scored (acceptance: ${rewardScore.acceptanceProbability.toFixed(2)}, rec: ${rewardScore.recommendation})`,
                            );
                        }
                    } catch (rewardErr) {
                        console.warn("💓 Proactive reward scoring failed (non-fatal):", (rewardErr as Error).message);
                    }

                    if (shouldSurface) {
                        console.log(`💓 Inner thought surfaced`);
                        await config.onNotification(thought); // the sender records the delivery (once)
                    }
                }
            } catch (err) {
                console.warn(`💓 Inner thoughts tick error:`, (err as Error).message);

                // Fallback to legacy proactive check if inner thoughts fails
                if (checkCount % 6 === 0) {
                    const isQuietHours = hourNow >= 0 && hourNow < 7;
                    if (
                        !(isQuietHours && (!presence.isActive || presence.isJustServerProcesses)) &&
                        presence.idleMinutes < 30
                    ) {
                        const check = await runProactiveCheck(llm, presence, hourNow);
                        if (check && config?.onNotification) {
                            const suppress = await shouldSuppressMessage(check);
                            if (!suppress) {
                                await config.onNotification(check);
                            }
                        }
                    }
                }
            }
            // ── Proactive Intelligence Modules ──────────

            // Habit Detector — once per day, detect recurring user patterns
            try {
                const habitKey = `habit_${todayStr}`;
                if (!(globalThis as Record<string, unknown>)[habitKey]) {
                    (globalThis as Record<string, unknown>)[habitKey] = true;
                    const { detectHabits } = await import("./habit-detector.js");
                    const { initMemoryDB } = await import("../memory/sqlite.js");
                    const memDb = await initMemoryDB();
                    const habits = detectHabits(memDb);
                    if (habits.length > 0) {
                        console.log(`💓 Habit detector: found ${habits.length} pattern(s)`);
                    }
                }
            } catch (err) {
                console.warn("💓 Habit detector error:", (err as Error).message);
            }

            // Environment Sensors — gather system/calendar/fs context each heartbeat
            try {
                const { getEnvironmentSnapshot } = await import("./environment-sensors.js");
                const snapshot = await getEnvironmentSnapshot();
                if (snapshot.upcomingCalendar.length > 0) {
                    console.log(`💓 Environment: ${snapshot.upcomingCalendar.length} upcoming event(s)`);
                }
            } catch (err) {
                console.warn("💓 Environment sensors error:", (err as Error).message);
            }

            // Recommendations — check for user behavior pattern suggestions
            try {
                const { getRecommendations } = await import("./recommendations.js");
                const recs = getRecommendations();
                if (recs.length > 0 && recs[0].confidence > 0.7) {
                    console.log(`💓 Recommendation: ${recs[0].text.substring(0, 80)}`);
                }
            } catch (err) {
                console.warn("💓 Recommendations error:", (err as Error).message);
            }
        } catch (err) {
            console.error("Heartbeat error:", (err as Error).message);
        }
    }, cfg.intervalMs);
    heartbeatTimer.unref?.();

    console.log(`💓 Heartbeat started (every ${cfg.intervalMs / 1000}s)`);
}

// ── Stop ──────────────────────────────────────

export function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log("💓 Heartbeat stopped");
    }
}

// ── Gather User Context ───────────────────────

function gatherUserContext(): string {
    const parts: string[] = [];

    try {
        const identity = getIdentityPromptSnippet();
        if (identity) parts.push(identity);
    } catch {
        /* identity not initialized */
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const coreMems = getCoreMemory(5);
        if (coreMems && coreMems.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parts.push("Key facts about the user:\n" + coreMems.map((m: any) => `- ${m.content}`).join("\n"));
        }
    } catch {
        /* DB not ready */
    }

    try {
        const episodic = getEpisodicSnippet();
        if (episodic) parts.push(episodic);
    } catch {
        /* no episodes yet */
    }

    try {
        const session = getSessionSummary();
        if (session) parts.push("Last session context:\n" + session);
    } catch {
        /* no session */
    }

    return parts.length > 0 ? parts.join("\n\n") : "";
}

// ── Proactive Check (Activity-Aware) ──────────

async function runProactiveCheck(llm: LLMClient, presence: UserPresence, hourNow: number): Promise<string | null> {
    const userContext = gatherUserContext();

    // If we have zero context, skip entirely
    if (!userContext) return null;

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: getTimezone(),
    });
    const activityDesc = describePresence(presence);
    const timeContext = getTimeContext();

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Time: ${timeStr} (${getTimezone()}) (${timeContext.period})
What they're doing: ${activityDesc}

Context about them:
${userContext}

${(() => {
    const topics = getUnrespondedProactiveTopics();
    return topics.length > 0
        ? `Already sent (no reply):\n${topics.map((t) => `- "${t}"`).join("\n")}\nDon't repeat these.\n`
        : "";
})()}

Should you say something? Only if it genuinely matters. Think:
- Would a real friend text this right now?
- Is it actually useful or just noise?
- At ${hourNow < 7 || hourNow >= 23 ? "this late hour" : "this time"}, is it appropriate?

If nothing is worth saying, just reply: NOTHING

If you do message, keep it VERY short. Like how you'd actually text. Not formal. Not helpful-assistant. Just human.`,
        },
    ];

    const response = await llm.chat({
        messages,
        systemPrompt: `You're their friend, not their assistant. TEXT like a friend. SHORT.

Good:
- "still at it huh"
- "take a break"
- "how's that going"
- (nothing — silence is fine)

Bad:
- "Hey! Just checking in on you! 👋"
- "Remember, you have that meeting tomorrow!"
- "Don't forget to take breaks! 🌟"

Be the first type. Or say nothing. Silence > noise.`,
    });

    const text = response.choices[0]?.message?.content || "NOTHING";
    if (text.trim().toUpperCase() === "NOTHING") return null;

    return text;
}
