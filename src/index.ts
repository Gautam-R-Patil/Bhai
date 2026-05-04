// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { loadConfig } from "./config.js";
import { createLLMClient } from "./llm.js";
import { createTelegramBot, sendProactiveMessage } from "./telegram.js";
import { initWhatsApp, closeWhatsApp, sendWhatsAppProactiveMessage } from "./whatsapp.js";
import { getToolNames, setSwarmLLM, setDeepResearchLLM, setLongTaskLLM, setDeepResearchNotifier, rotateAuditLog, loadDynamicTools, setCodeActionLLM, setCodeActionExecutor, setComputerUseLLM, executeTool, registerChannelSender, setPresentationLLM, setIngestLLM, setBrandAuditLLM, setScriptWriterLLM, setCampaignPlannerLLM, setOutreachLLM, setProductHuntLLM } from "./tools/index.js";
import { initMemoryDB, embedExistingMemories, setMemoryLLM } from "./memory/sqlite.js";
import { initKnowledgeGraph } from "./memory/knowledge-graph.js";
import { initSupabase } from "./memory/supabase.js";
import { initIdentityDB } from "./memory/identity.js";
import { initTraitsDB, setMemoryDebug } from "./memory/traits.js";
import { seedProfileIfPresent } from "./setup/wizard-seed.js";
import { runDailyDecay, runDreamReplay } from "./memory/reflection.js";
import { initSelfStateDB } from "./memory/self-state.js";
import { initEmotionalMemory } from "./memory/emotional.js";
import { initEpisodicMemory } from "./memory/episodic.js";
import { initRelationshipState } from "./memory/relationship.js";
import { initWorkingMemory } from "./memory/working-memory.js";
import { initMCPServers, closeMCPServers } from "./mcp/client.js";
import { initToolRouter, setToolRouterLLM } from "./tool-router.js";
import { initSkillMetadata } from "./skills/loader.js";
import { setupTelegramVoice } from "./voice/telegram-voice.js";
import { startHeartbeat, stopHeartbeat } from "./proactive/heartbeat.js";
import { startCronTicker, stopCronTicker } from "./cron/tick.js";
import { loadJobs } from "./cron/store.js";
import { runAgent } from "./agent.js";
import { setTaskTriggerHandler } from "./tools/scheduled.js";
import { initSandbox } from "./security/sandbox.js";
import { loadPluginConfig } from "./plugins/registry.js";
import { closeBrowser, initChromeBridge, closeChromeBridge, registerPlaywrightBackend, registerChromeBackend, initActionCache } from "./tools/browser/index.js";
import { initBrowserMemory } from "./tools/browser-memory.js";
import { initTaskLearnings } from "./memory/task-learnings.js";
import { initStrategyLibrary } from "./memory/strategy-library.js";
import { initCounterfactualMemory } from "./memory/counterfactual.js";
import { initWorldModel } from "./memory/world-model.js";
import { initUserModel } from "./memory/user-model.js";
import { initSelfModel } from "./memory/self-model.js";
import { initGoals } from "./memory/goals.js";
import { closeCanvas, initCanvas } from "./canvas/server.js";
import { initGoogleAPI } from "./tools/google-api.js";
import { initSpotify } from "./tools/spotify.js";
import { initOverlayChat, closeOverlayChat, sendOverlayNotification } from "./overlay/overlay-chat.js";
import { initEmail, closeEmail } from "./email.js";
import { initSlack, closeSlack, sendSlackProactiveMessage } from "./slack.js";
import { initDiscord, closeDiscord, sendDiscordProactiveMessage } from "./discord.js";
import { initMatrix, closeMatrix, sendMatrixProactiveMessage } from "./matrix.js";
import { sendPushNotification, getSubscriptionCount } from "./notifications/push.js";
import { initAccountGuard, checkAccountStatus } from "./account-guard.js";
import { initSession, revokeCurrentSession } from "./session.js";
import { startNetworkMonitor, stopNetworkMonitor, onNetworkStatusChange, getOnlineNotificationMessage } from "./network-health.js";
import { warmup as warmupEmbeddings, isReady as isEmbeddingsReady } from "./memory/embeddings.js";
import { autoResumeInterruptedTasks } from "./agents/long-task.js";
import { initCredibilityModel } from "./research/credibility-model.js";
import { initLocationService, refreshLocation, onLocationChange } from "./location/index.js";
import { startNetworkWatcher, stopNetworkWatcher } from "./location/network-watcher.js";
import { getPlatformCapabilities } from "./utils/platform-capabilities.js";
import { initRegistry } from "./harness/registry.js";

// ── Primary Channel ──────────────────────────
const PRIMARY_CHANNEL = process.env.PRIMARY_CHANNEL || "telegram";

// ── Banner ────────────────────────────────────

console.log(`
  ╔══════════════════════════════════════╗
  ║       🤖 A.T.L.A.S v0.2.0            ║
  ║   Personal AI Agent · All Systems    ║
  ╚══════════════════════════════════════╝
`);

// ── Boot ──────────────────────────────────────

const config = loadConfig();
const llm = createLLMClient(config);
setSwarmLLM(llm);          // Inject into swarm tool
setToolRouterLLM(llm);     // Inject into tool router for LLM intent classification
setDeepResearchLLM(llm);   // Inject into deep research tool
setLongTaskLLM(llm);       // Inject into long task executor
setCodeActionLLM(llm);     // Inject into code-as-action agent tool
setCodeActionExecutor(executeTool);  // Inject tool executor for code_execute sandbox
setComputerUseLLM(llm);    // Inject into computer use agent tool
setMemoryLLM(llm);         // Inject into memory for smart write decisions
setPresentationLLM(llm);   // Inject into presentation generator
setIngestLLM(llm);         // Inject into PDF → JSON ingestion (vision-LLM fallback)
setBrandAuditLLM(llm);        // Inject into brand audit orchestrator
setScriptWriterLLM(llm);      // Inject into marketing script writer
setCampaignPlannerLLM(llm);   // Inject into campaign planner
setOutreachLLM(llm);          // Inject into cold outreach engine
setProductHuntLLM(llm);       // Inject into Product Hunt launch module

// ── Initialize Subsystems ─────────────────────

async function boot() {
    // ── Session (must run first — creates auth token for all Convex calls) ──
    // Retry up to 3 times with backoff for transient network failures
    let sessionOk = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        sessionOk = await initSession();
        if (sessionOk) break;
        if (attempt < 3) {
            const delay = attempt * 3000;
            console.warn(`⚠️  Session creation failed (attempt ${attempt}/3) — retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    if (!sessionOk) {
        console.error("❌ Failed to create session after 3 attempts — exiting");
        process.exit(1);
    }
    console.log(`✅ Session established`);

    // ── Network Health Monitor ────────
    startNetworkMonitor();
    onNetworkStatusChange((event) => {
        if (event.next === "online" && event.prev === "offline") {
            // Notify user that internet is back
            sendOverlayNotification(getOnlineNotificationMessage());
            refreshLocation().catch(() => { /* non-fatal */ });
        }
    });

    // ── Harness Registry ─────
    // Load active harness config (if any) before tool infrastructure and agent loop.
    // Falls back to hardcoded defaults gracefully if no active config exists.
    initRegistry();

    // ── Account Guard ────────
    // checkAccountStatus() uses the session token to verify credits via Convex HTTP proxy.
    await initAccountGuard();
    console.log(`✅ Account verified via Convex`);

    try {
        // Memory
        const memDb = await initMemoryDB();
        initKnowledgeGraph(memDb);
        initCredibilityModel(memDb);
        initIdentityDB(memDb);
        initTraitsDB(memDb);

        // Seed identity from the setup wizard's `.user-profile.json` (if present).
        // Idempotent across restarts — renames source to `.user-profile.seeded.json`
        // after successful seed. Source lives in the Electron app's userData dir,
        // exposed to the bot via ATLAS_USER_DATA_DIR; falls back to ATLAS_DATA_DIR.
        try {
            const seedResult = seedProfileIfPresent({
                userDataDir: process.env.ATLAS_USER_DATA_DIR,
                dataDir: process.env.ATLAS_DATA_DIR,
            }, { log: (m) => console.log(m) });
            if (seedResult.ran) {
                console.log(`🌱 Wizard profile seeded: ${seedResult.seeded?.name}`);
            }
        } catch (err) {
            console.warn("[wizard-seed] non-fatal error:", (err as Error).message);
        }

        initSupabase();

        // Living Continuity layers
        initSelfStateDB(memDb);
        initEmotionalMemory(memDb);
        initEpisodicMemory(memDb);
        initRelationshipState(memDb);

        // Counterfactual Memory — regret-based learning from past decisions
        try {
            initCounterfactualMemory(memDb);
        } catch (cfErr) {
            console.warn("[BOOT] Counterfactual memory init failed (non-fatal):", (cfErr as Error).message);
        }

        // World Model — tracks tool/API/service health for informed planning
        try {
            initWorldModel(memDb);
        } catch (wmErr) {
            console.warn("[BOOT] World model init failed (non-fatal):", (wmErr as Error).message);
        }

        // User Model — aggregated user profile for proactive context
        try {
            initUserModel(memDb);
        } catch (umErr) {
            console.warn("[BOOT] User model init failed (non-fatal):", (umErr as Error).message);
        }

        // Self Model — tracks agent capability success/failure rates
        try {
            initSelfModel(memDb);
        } catch (smErr) {
            console.warn("[BOOT] Self model init failed (non-fatal):", (smErr as Error).message);
        }

        // Goals — persistent user goal tracking with progress and deadlines
        try {
            initGoals(memDb);
        } catch (gErr) {
            console.warn("[BOOT] Goals init failed (non-fatal):", (gErr as Error).message);
        }

        // Prompt Evolver — records per-turn outcomes so /optimize-harness can A/B prompts.
        try {
            const { initPromptEvolver } = await import("./prompts/prompt-evolver.js");
            initPromptEvolver(memDb);
        } catch (peErr) {
            console.warn("[BOOT] Prompt evolver init failed (non-fatal):", (peErr as Error).message);
        }

        // Working Memory — bounded attention-weighted buffer for active context
        try {
            initWorkingMemory();
        } catch (wmErr) {
            console.warn("[BOOT] Working memory init failed (non-fatal):", (wmErr as Error).message);
        }

        // Inner Thoughts Engine — background reasoning pipeline for proactive thoughts
        try {
            const { initInnerThoughts } = await import("./proactive/inner-thoughts.js");
            initInnerThoughts(memDb, llm, {
                onThoughtSurfaced: async (message) => {
                    console.log(`[BOOT] Inner thought surfaced: ${message.substring(0, 80)}...`);
                },
            });
        } catch (itErr) {
            console.warn("[BOOT] Inner thoughts init failed (non-fatal):", (itErr as Error).message);
        }

        // Goal Engine — autonomous goal generation and lifecycle management
        try {
            const { initGoalEngine } = await import("./proactive/goal-engine.js");
            initGoalEngine(memDb);
        } catch (geErr) {
            console.warn("[BOOT] Goal engine init failed (non-fatal):", (geErr as Error).message);
        }

        // Notification Tracker — tracks proactive messages and measures user engagement
        try {
            const { initNotificationTracker } = await import("./proactive/notification-tracker.js");
            initNotificationTracker(memDb);
        } catch (ntErr) {
            console.warn("[BOOT] Notification tracker init failed (non-fatal):", (ntErr as Error).message);
        }
    } catch (err) {
        console.warn("\n⚠️ [BOOT] FAILED TO INITIALIZE MEMORY DATABASE");
        console.warn("⚠️ Native module (better-sqlite3) could not be loaded. A.T.L.A.S will run without memory persistence.");
        console.warn("   Error: " + (err as Error).message + "\n");
    }

    // Enable memory debug logging in development
    if (process.env.MEMORY_DEBUG === "true" || process.env.NODE_ENV === "development") {
        setMemoryDebug(true);
    }

    // ── Phase 2: Parallel subsystem initialization (no inter-dependencies) ──
    // These subsystems don't depend on each other — run them concurrently.
    // Each is wrapped with .catch() for fail-open resilience.
    await Promise.all([
        // MCP servers
        initMCPServers().catch(e => console.warn("[BOOT] MCP:", (e as Error).message)),
        // Skills (fetch metadata from server — instructions stay server-side)
        initSkillMetadata().catch(e => console.warn("[BOOT] Skills:", (e as Error).message)),
        // Plugins
        loadPluginConfig().catch(e => console.warn("[BOOT] Plugins:", (e as Error).message)),
        // Load persisted dynamic tools (created by create_tool with persistent=true)
        loadDynamicTools().catch(e => console.warn("[BOOT] Dynamic tools:", (e as Error).message)),
        // Hooks (user + project ~/.atlas/hooks.json and .atlas/hooks.json)
        import("./hooks/index.js").then((mod) => mod.loadHooks())
            .catch(e => console.warn("[BOOT] Hooks:", (e as Error).message)),
        // Tool intelligence: rotate audit log on boot (keep last 7 days)
        rotateAuditLog().catch(e => console.warn("[BOOT] Audit log rotation:", (e as Error).message)),
        // Canvas (WebSocket)
        Promise.resolve().then(() => initCanvas()).catch(e => console.warn("[BOOT] Canvas:", (e as Error).message)),
        // Google APIs (load saved accounts)
        Promise.resolve().then(() => initGoogleAPI()).catch(e => console.warn("[BOOT] Google API:", (e as Error).message)),
        // Spotify (load saved tokens)
        Promise.resolve().then(() => initSpotify()).catch(e => console.warn("[BOOT] Spotify:", (e as Error).message)),
        // Overlay chat (desktop "Type to A.T.L.A.S")
        Promise.resolve().then(() => initOverlayChat(llm)).catch(e => console.warn("[BOOT] Overlay:", (e as Error).message)),
        // Email channel (IMAP listener + SMTP sender)
        initEmail(llm, config).catch(e => console.warn("[BOOT] Email:", (e as Error).message)),
        // Slack bot (Socket Mode — only if SLACK_BOT_TOKEN is set)
        initSlack(llm).catch(e => console.warn("[BOOT] Slack:", (e as Error).message)),
        // WhatsApp channel (Baileys QR pairing — only if WHATSAPP_ALLOWED_JIDS is set)
        initWhatsApp(llm).catch(e => console.warn("[BOOT] WhatsApp:", (e as Error).message)),
        // Discord bot (slash commands + @mention — only if DISCORD_BOT_TOKEN is set)
        initDiscord(llm).catch(e => console.warn("[BOOT] Discord:", (e as Error).message)),
        // Matrix/Element bot (CS API long-poll — only if MATRIX_HOMESERVER is set)
        initMatrix(llm).catch(e => console.warn("[BOOT] Matrix:", (e as Error).message)),
        // Location service (GPS → Wi-Fi → IP fallback chain)
        initLocationService().catch(e => console.warn("[BOOT] Location:", (e as Error).message)),
    ]);

    // Location: start SSID watcher + hook into network recovery
    startNetworkWatcher();

    // Auto-update identity profile when location changes
    onLocationChange((data) => {
        try {
            const { getIdentityProfile, updateIdentityProfile } = require("./memory/identity.js");
            const locationStr = [data.city, data.region, data.countryName || data.country].filter(Boolean).join(", ");
            const currentProfile = getIdentityProfile();
            if (currentProfile.location !== locationStr && locationStr) {
                updateIdentityProfile({ location: locationStr });
                console.log(`[LOCATION] Identity updated: ${locationStr}`);
            }
        } catch { /* identity not initialized */ }
    });

    // Browser strategy memory + action cache + unified task learnings (sync inits, fast)
    initBrowserMemory();
    initActionCache();
    initTaskLearnings();
    initStrategyLibrary();

    // Chrome Bridge (WebSocket for Chrome extension — lets agent use real Chrome tabs)
    initChromeBridge();

    // Register browser backend factories for the abstraction layer.
    {
        const { ChromeExtensionBackend } = await import("./tools/browser/chrome-backend.js");
        const { PlaywrightPassthroughBackend } = await import("./tools/browser/playwright-backend.js");
        registerPlaywrightBackend(() => new PlaywrightPassthroughBackend());
        registerChromeBackend(() => new ChromeExtensionBackend());
    }

    // Docker sandbox (optional)
    initSandbox();

    // ── Phase 3: Background warmup (non-blocking — don't await) ──
    // Embedding warmup runs in background so boot isn't blocked by ONNX initialization.
    // Will load on first use if warmup hasn't completed yet.
    warmupEmbeddings()
        .then(() => console.log("   Embed  : model pre-warmed ✅"))
        .catch(err => console.warn("[BOOT] Embedding warmup failed (non-fatal — will load on first use):", (err as Error).message));

    // Semantic embeddings migration (async, non-blocking — runs in background)
    embedExistingMemories().catch(err =>
        console.warn("[BOOT] Embedding migration failed (non-fatal):", err)
    );

    // HNSW embedding version migration (async, non-blocking)
    // If the embedding model version changed, re-embed old memories in batches
    (async () => {
        try {
            const { migrateEmbeddingsBatch } = await import("./memory/vector-index.js");
            const { getRawDb } = await import("./memory/sqlite.js");
            const raw = getRawDb();
            if (raw) {
                const result = await migrateEmbeddingsBatch(raw, 50);
                if (result.migrated > 0) {
                    console.log(`   Migrate : ${result.migrated} embeddings re-embedded (${result.remaining} remaining)`);
                }
            }
        } catch (migErr) {
            console.warn("[BOOT] Embedding version migration failed (non-fatal):", (migErr as Error).message);
        }
    })();

    // Hopfield Associative Memory: load patterns from HNSW index (background)
    (async () => {
        try {
            if (isEmbeddingsReady()) {
                const { loadFromHNSW } = await import("./memory/hopfield-memory.js");
                const { bufferToEmbedding } = await import("./memory/embeddings.js");
                const memRawDb = (await import("./memory/sqlite.js")).getRawDb();
                if (memRawDb) {
                    const rows = memRawDb.prepare(
                        `SELECT e.memory_id, e.embedding, m.content
                         FROM memory_embeddings e
                         JOIN memories m ON e.memory_id = m.id
                         LIMIT 500`
                    ).all() as Array<{ memory_id: number; embedding: Buffer; content: string }>;
                    if (rows.length > 0) {
                        const entries = rows.map(r => ({
                            id: r.memory_id,
                            embedding: bufferToEmbedding(r.embedding),
                            content: r.content,
                        }));
                        loadFromHNSW(entries);
                    }
                }
            }
        } catch (hfErr) {
            console.warn("[BOOT] Hopfield memory init failed (non-fatal):", (hfErr as Error).message);
        }
    })();

    // Smart tool router (pre-compute category embeddings — async, non-blocking)
    initToolRouter().catch(err =>
        console.warn("[BOOT] Tool router init failed (non-fatal, will use structural fallback):", err)
    );

    // Warm up platform capability probe (non-blocking)
    if (process.env.ATLAS_SKIP_CAPABILITY_PROBE !== "true") {
        getPlatformCapabilities().catch(err => console.warn("[boot] capability probe failed:", err));
    }

    // Auto-resume any long tasks that were interrupted (async, non-blocking)
    autoResumeInterruptedTasks(llm)
        .then(({ resumed }) => {
            if (resumed.length > 0) {
                console.log(`   Tasks  : ${resumed.length} interrupted task(s) auto-resumed`);
            }
        })
        .catch(err => console.warn("[BOOT] Long task auto-resume failed (non-fatal):", err));

    // ── Create Telegram Bot ───────────────────
    const bot = createTelegramBot(config, llm);

    // ── Register cross-channel senders (for send_message_on_channel tool) ──
    registerChannelSender("telegram", async (message, filePath) => {
        await sendProactiveMessage(bot, config, message, filePath);
    });
    registerChannelSender("whatsapp", async (message, filePath) => {
        await sendWhatsAppProactiveMessage(message, filePath);
    });
    registerChannelSender("discord", async (message, filePath) => {
        await sendDiscordProactiveMessage(message, filePath);
    });
    registerChannelSender("slack", async (message) => {
        await sendSlackProactiveMessage(message);
    });
    registerChannelSender("matrix", async (message) => {
        await sendMatrixProactiveMessage(message);
    });
    registerChannelSender("overlay", async (message) => {
        sendOverlayNotification(message);
    });

    // Wire deep research proactive notifier (background research sends progress here)
    setDeepResearchNotifier(async (msg: string) => {
        // Primary channel gets the message first
        const sendPrimary: Record<string, () => Promise<void>> = {
            telegram: () => sendProactiveMessage(bot, config, msg),
            whatsapp: () => sendWhatsAppProactiveMessage(msg),
            discord: () => sendDiscordProactiveMessage(msg),
            slack: () => sendSlackProactiveMessage(msg),
            matrix: () => sendMatrixProactiveMessage(msg),
            overlay: () => { sendOverlayNotification(msg); return Promise.resolve(); },
        };

        // Send to primary channel
        const primaryFn = sendPrimary[PRIMARY_CHANNEL];
        if (primaryFn) {
            try { await primaryFn(); } catch { /* primary failed, will try others */ }
        }

        // Send to other active channels as backup (non-blocking)
        for (const [channel, fn] of Object.entries(sendPrimary)) {
            if (channel !== PRIMARY_CHANNEL) fn().catch(() => {});
        }

        // Push notification for background research completion
        if (msg.includes("complete") || msg.includes("finished")) {
            sendPushNotification("Research Complete", msg.substring(0, 180)).catch(() => {});
        }
    });

    // Wire voice handlers
    setupTelegramVoice(bot, llm);

    // Live voice mode (real-time conversation — Gemini Live / OpenAI Realtime)
    try {
        const { initLiveVoice } = await import("./voice/live/integration.js");
        await initLiveVoice(llm);
    } catch (err) {
        console.warn("[BOOT] Live voice init failed (non-fatal):", (err as Error).message);
    }

    // ── Startup Info ──────────────────────────
    const toolNames = getToolNames();

    console.log(`\n📋 Config loaded`);
    console.log(`   Model   : Pro`);
    console.log(`   Provider: XAGI Labs`);
    console.log(`   Users   : ${config.allowedUserIds.size} allowed`);
    console.log(`   Tools   : ${toolNames.length} registered`);
    console.log(`   Skills  : server-side (metadata cached)`);
    console.log();

    // ── Heartbeat ─────────────────────────────
    startHeartbeat(llm, {
        intervalMs: 30 * 60 * 1000, // 30 minutes
        onNotification: async (message) => {
            console.log(`💓 Proactive: ${message.substring(0, 100)}...`);

            // Phase 2.3+ architecture: the Observer owns dispatch end-to-end.
            // It enqueues via Rust scheduler, releases at boundary events,
            // runs every intent through the Composer (which rejects banned
            // phrases + third-person text), and dispatches to channels.
            //
            // If the Observer isn't ready yet (init failed at boot, or the
            // V2 flag is off), we fall back to the Phase 1 Composer+dispatch
            // fan-out — still safe because every message still flows through
            // the Composer's second-person post-filter.
            //
            // The pre-Phase-1 "legacy" path (raw fan-out) was removed in
            // Task 5.1. If both Observer AND V2 Composer are unavailable,
            // we stay silent rather than risk re-introducing the leak.

            try {
                const { getObserver } = await import("./proactive/observer.js");
                const obs = getObserver();
                if (obs) {
                    const { intentFromThought } = await import("./proactive/intent-from-thought.js");
                    obs.enqueue(intentFromThought(message, { hourNow: new Date().getHours() }));
                    if (getSubscriptionCount() > 0) {
                        sendPushNotification("A.T.L.A.S", message.substring(0, 180)).catch(() => {});
                    }
                    return;
                }
            } catch (err) {
                console.log("[proactive] Observer dispatch failed, falling back:", (err as Error).message);
            }

            // Fallback: Observer unavailable — still route through Composer + dispatch
            // (this is what shipped in Phase 1, before the scheduler landed).
            try {
                const { intentFromThought } = await import("./proactive/intent-from-thought.js");
                const { compose } = await import("./proactive/composer.js");
                const { dispatchProactiveMessage } = await import("./proactive/dispatch.js");
                const intent = intentFromThought(message, { hourNow: new Date().getHours() });
                const channelOrder: Array<"telegram" | "whatsapp" | "discord" | "slack" | "matrix" | "overlay"> = [
                    "telegram", "whatsapp", "discord", "slack", "matrix", "overlay",
                ];
                const primary = channelOrder.find((c) => c === PRIMARY_CHANNEL);
                const rest = channelOrder.filter((c) => c !== primary);
                const sendOne = async (channel: typeof channelOrder[number]): Promise<void> => {
                    const composed = await compose(intent, channel, { tone: "warm" }, [], { llm });
                    if (!composed) return;
                    await dispatchProactiveMessage(channel, composed.text, composed.modeTag);
                };
                if (primary) {
                    try { await sendOne(primary); } catch (err) {
                        console.log(`proactive dispatch failed (${primary}):`, (err as Error).message);
                    }
                }
                for (const c of rest) sendOne(c).catch((err) => {
                    console.log(`proactive dispatch failed (${c}):`, (err as Error).message);
                });
                if (getSubscriptionCount() > 0) {
                    sendPushNotification("A.T.L.A.S", message.substring(0, 180)).catch(() => {});
                }
            } catch (err) {
                console.log("[proactive] Composer fallback also failed — staying silent:", (err as Error).message);
            }
        },
    });

    // ── Proactive Observer (V2 scheduler) ─────
    if (process.env.ATLAS_PROACTIVE_V2_SCHEDULER !== "false") {
        try {
            const { Observer, setObserver } = await import("./proactive/observer.js");
            const { join } = await import("node:path");
            const obs = new Observer({
                llm,
                configPath: join(process.cwd(), "data", "proactive-config.json"),
            });
            obs.start();
            setObserver(obs);
            console.log("💓 Proactive Observer started (V2 scheduler)");

            // ── Telemetry (Phase 5.2) ──
            try {
                const { getRawDb } = await import("./memory/sqlite.js");
                const { TelemetryLogger, setTelemetry } = await import("./proactive/telemetry.js");
                const raw = getRawDb();
                if (raw) {
                    setTelemetry(new TelemetryLogger(raw));
                    console.log("💓 Proactive telemetry enabled");
                }
            } catch (err) {
                console.log("[BOOT] telemetry init failed (non-fatal):", (err as Error).message);
            }

            // ── Initialize InboxManager (Phase 4.1/4.2) ──
            try {
                const { getRawDb } = await import("./memory/sqlite.js");
                const { InboxStore } = await import("./proactive/inbox/store.js");
                const { InboxManager, setInboxManager } = await import("./proactive/inbox/manager.js");
                const { executeApprovedIntent } = await import("./proactive/inbox/executor.js");
                const { executeTool } = await import("./tools/index.js");
                const raw = getRawDb();
                if (raw) {
                    const store = new InboxStore(raw);
                    const manager = new InboxManager({
                        store,
                        executor: (toolCalls) => executeApprovedIntent(toolCalls, { executeTool }),
                    });
                    setInboxManager(manager);
                    console.log(
                        "💓 Inbox manager ready (%d pending)",
                        manager.listPending().length,
                    );

                    // Periodic expiry sweep (every hour; items older than 7d expire)
                    const EXPIRY_MS = 7 * 24 * 60 * 60_000;
                    setInterval(() => { manager.expireOlderThan(EXPIRY_MS); }, 60 * 60_000);

                    // Periodic deferred-ready sweep (every minute)
                    setInterval(() => { manager.readyDeferred(); }, 60_000);
                } else {
                    console.log("[BOOT] InboxManager skipped: no raw DB handle");
                }
            } catch (err) {
                console.log(
                    "[BOOT] InboxManager init failed (non-fatal):",
                    (err as Error).message,
                );
            }

            // ── Chat fallback subscription (Phase 4.3) ──
            // When the overlay isn't connected, review-mode inbox prompts
            // surface on the primary chat channel (Telegram buttons or
            // WhatsApp numbered reply) so the user can still act on them.
            try {
                const { startInboxChatFallback } = await import("./proactive/inbox/chat-fallback.js");
                startInboxChatFallback();
                console.log("💓 Inbox chat fallback subscribed");
            } catch (err) {
                console.log("[BOOT] inbox fallback init failed (non-fatal):", (err as Error).message);
            }

            // ── Register memory_anticipation source (Phase 3 Task 3.2) ──
            try {
                const { makeMemoryAnticipationSource } = await import("./proactive/sources/memory-anticipation.js");
                const { tick: innerTick } = await import("./proactive/inner-thoughts.js");
                const { getUserPresence } = await import("./proactive/activity.js");
                const { embedText } = await import("./memory/embeddings.js");
                obs.registerSource(makeMemoryAnticipationSource({
                    tick: async (ctxIn) => innerTick(ctxIn),
                    embedText: async (t) => await embedText(t, "query"),
                    getPresence: () => getUserPresence(),
                }));
                console.log("💓 Registered source: memory_anticipation");
            } catch (err) {
                console.log("[BOOT] memory_anticipation source registration failed (non-fatal):", (err as Error).message);
            }

            // ── Register long_task_status source (Phase 3 Task 3.3) ──
            try {
                const { makeLongTaskStatusSource } = await import("./proactive/sources/long-task-status.js");
                obs.registerSource(makeLongTaskStatusSource());
                console.log("💓 Registered source: long_task_status");
            } catch (err) {
                console.log("[BOOT] long_task_status source registration failed (non-fatal):", (err as Error).message);
            }

            // ── Register latent_topic_monitor source (Phase 3 Task 3.9d) ──
            // Opens the memory DB raw handle, constructs a MonitorStore around
            // the monitor_rules table (created in Task 0.2), pushes all active
            // rules into the Rust matcher at boot, and registers the source.
            // Every piece is inside its own try/catch so partial failures keep
            // the other sources running.
            try {
                const { getRawDb } = await import("./memory/sqlite.js");
                const { MonitorStore } = await import("./proactive/monitors/monitor-store.js");
                const { setMonitorStore } = await import("./proactive/monitors/store-singleton.js");
                const { makeLatentTopicMonitorSource } = await import(
                    "./proactive/sources/latent-topic-monitor.js"
                );
                const { ruleToRust } = await import("./proactive/chat-commands.js");
                const native = await import("../native/index.js");
                const rawDb = getRawDb();
                if (!rawDb) {
                    throw new Error("memory DB not initialized");
                }
                const store = new MonitorStore(rawDb);
                setMonitorStore(store);

                const nativeMon = native as unknown as {
                    monitorLoadRules?: (rules: unknown[]) => void;
                };
                if (typeof nativeMon.monitorLoadRules === "function") {
                    const activeRules = store.list(true).map(ruleToRust);
                    nativeMon.monitorLoadRules(activeRules);
                    console.log(
                        `💓 Loaded ${activeRules.length} monitor rule(s) into Rust matcher`,
                    );
                }
                obs.registerSource(makeLatentTopicMonitorSource());
                console.log("💓 Registered source: latent_topic_monitor");
            } catch (err) {
                console.log(
                    "[BOOT] latent_topic_monitor source registration failed (non-fatal):",
                    (err as Error).message,
                );
            }
        } catch (err) {
            console.log("[BOOT] Observer init failed (non-fatal):", (err as Error).message);
        }
    }

    // ── Scheduled Tasks ───────────────────────
    setTaskTriggerHandler(async (taskId: string, action: string) => {
        // ── Marketing scheduled post detection ──────────────────────────────
        // Actions encoded as JSON by marketing_schedule tool are executed directly.
        // Format: {"__marketing_post":true,"brandId":"...","itemId":N,"platform":"...","caption":"...","mediaPath":"...","hashtags":[...]}
        if (action.startsWith('{"__marketing_post":')) {
            try {
                const params = JSON.parse(action) as {
                    __marketing_post: boolean;
                    brandId: string;
                    itemId: number;
                    platform: string;
                    contentType: string;
                    caption: string;
                    mediaPath?: string;
                    hashtags?: string[];
                };
                const result = await executeTool("social_post", {
                    platform: params.platform,
                    brand_id: params.brandId,
                    content_type: params.contentType,
                    caption: params.caption,
                    media_path: params.mediaPath,
                    hashtags: params.hashtags ?? [],
                    item_id: params.itemId,
                });
                const parsed = JSON.parse(result) as { success?: boolean; postUrl?: string; error?: string };
                const confirmMsg = parsed.success
                    ? `✅ Posted to ${params.platform}! ${parsed.postUrl ?? ""}`
                    : `❌ Marketing post failed: ${parsed.error ?? result}`;
                sendPushNotification("Marketing Post", confirmMsg.substring(0, 180)).catch(() => {});
                // Deliver confirmation to active channels
                const { deliverToActiveChannel } = await import("./tools/channel-send.js");
                deliverToActiveChannel(confirmMsg, "").catch(() => {});
            } catch (err) {
                sendPushNotification("Marketing Post Failed", (err as Error).message.substring(0, 180)).catch(() => {});
            }
            return;
        }

        const message = `🔔 **Task Triggered**\n\n${action}`;

        // Primary channel gets the message first
        const sendPrimary: Record<string, () => Promise<void>> = {
            telegram: () => sendProactiveMessage(bot, config, message),
            whatsapp: () => sendWhatsAppProactiveMessage(message),
            discord: () => sendDiscordProactiveMessage(message),
            slack: () => sendSlackProactiveMessage(message),
            matrix: () => sendMatrixProactiveMessage(message),
            overlay: () => { sendOverlayNotification(message); return Promise.resolve(); },
        };

        // Send to primary channel
        const primaryFn = sendPrimary[PRIMARY_CHANNEL];
        if (primaryFn) {
            try { await primaryFn(); } catch { /* primary failed, will try others */ }
        }

        // Send to other active channels as backup (non-blocking)
        for (const [channel, fn] of Object.entries(sendPrimary)) {
            if (channel !== PRIMARY_CHANNEL) fn().catch(() => {});
        }

        // Always send push notification for task triggers
        sendPushNotification("Task Triggered", action.substring(0, 180)).catch(() => {});
    });

    // ── Decay (every 6h) + Dream Replay (nightly) ───
    const scheduleDecayAndReplay = () => {
        const now = new Date();
        const next3am = new Date(now);
        next3am.setHours(3, 0, 0, 0);
        if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
        const msUntil = next3am.getTime() - now.getTime();

        // First run at 3am, then decay every 6h
        setTimeout(() => {
            runDailyDecay();
            runDreamReplay(llm).catch(err =>
                console.error("[MEMORY][REPLAY] Dream replay failed:", err)
            );
            // Decay runs every 6 hours for cleaner memory
            setInterval(() => {
                runDailyDecay();
            }, 6 * 60 * 60 * 1000);
            // Dream replay stays nightly (24h)
            setInterval(() => {
                runDreamReplay(llm).catch(err =>
                    console.error("[MEMORY][REPLAY] Dream replay failed:", err)
                );
            }, 24 * 60 * 60 * 1000);
        }, msUntil);

        console.log(`   Decay   : every 6h (next at ${next3am.toLocaleTimeString()})`);
        console.log(`   Replay  : dream replay scheduled nightly`);
    };
    scheduleDecayAndReplay();

    // ── Cron Scheduler ────────────────────────
    try {
        await loadJobs();
        startCronTicker({
            runPrompt: async (prompt, ctx) => {
                const channel = (ctx.deliverTo || "cron") as string;
                const response = await runAgent(
                    llm,
                    prompt,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    {
                        channel,
                        userId: ctx.userId || "cron",
                        isOwner: ctx.isOwner,
                    },
                );
                return response.text;
            },
            deliver: async (job, response) => {
                const channel = job.deliverTo;
                if (!channel || !response) return true;
                if (channel === "telegram") {
                    const { getTelegramBot, getTelegramConfig, sendProactiveMessage: sendTg } = await import("./telegram.js");
                    const tb = getTelegramBot();
                    const cfg = getTelegramConfig();
                    if (!tb || !cfg) return false;
                    await sendTg(tb, cfg, response);
                    return true;
                }
                if (channel === "slack") {
                    const { sendSlackProactiveMessage } = await import("./slack.js");
                    await sendSlackProactiveMessage(response);
                    return true;
                }
                if (channel === "discord") {
                    const { sendDiscordProactiveMessage } = await import("./discord.js");
                    await sendDiscordProactiveMessage(response);
                    return true;
                }
                if (channel === "matrix") {
                    const { sendMatrixProactiveMessage } = await import("./matrix.js");
                    await sendMatrixProactiveMessage(response);
                    return true;
                }
                if (channel === "overlay") {
                    const { sendOverlayNotification } = await import("./overlay/overlay-chat.js");
                    sendOverlayNotification(response);
                    return true;
                }
                console.error(
                    `[CRON] MISROUTED — job ${job.id} had deliverTo="${channel}" which has no handler. Response (${response.length} chars) was dropped.`,
                );
                return false;
            },
        });
        console.log(`   Cron    : ticker started (60s interval)`);
    } catch (cronErr) {
        console.warn("[CRON] Ticker failed to start (non-fatal):", (cronErr as Error).message);
    }

    // ── Start Bot ─────────────────────────────
    bot.start({
        onStart: (botInfo) => {
            console.log(`✅ Bot online: @${botInfo.username}`);
            console.log(`   Mode    : long-polling (no HTTP server)`);
            console.log(`   Tools   : ${toolNames.join(", ")}`);
            console.log(`   Send me a message on Telegram to get started!\n`);
        },
    });

    // ── Graceful Shutdown ─────────────────────
    async function shutdown(signal: string) {
        console.log(`\n🛑 Received ${signal}, shutting down...`);
        bot.stop();
        stopHeartbeat();
        stopNetworkMonitor();
        stopNetworkWatcher();
        await closeMCPServers();
        await closeBrowser();
        closeChromeBridge();
        closeCanvas();
        closeOverlayChat();
        closeSlack();
        closeMatrix();
        await closeDiscord();
        await closeWhatsApp();
        await closeEmail();
        await revokeCurrentSession();
        process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ── Run ───────────────────────────────────────

boot().catch((err) => {
    console.error("❌ Boot failed:", err);
    process.exit(1);
});
