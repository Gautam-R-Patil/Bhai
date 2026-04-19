// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { loadConfig } from "./config.js";
import { createLLMClient } from "./llm.js";
import { createTelegramBot, sendProactiveMessage } from "./telegram.js";
import { initWhatsApp, closeWhatsApp, sendWhatsAppProactiveMessage } from "./whatsapp.js";
import { getToolNames, setSwarmLLM, setDeepResearchLLM, setLongTaskLLM, setDeepResearchNotifier, rotateAuditLog, loadDynamicTools, setCodeActionLLM, setCodeActionExecutor, setComputerUseLLM, executeTool, registerChannelSender, setPresentationLLM, setIngestLLM } from "./tools/index.js";
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
    registerChannelSender("telegram", async (message) => {
        await sendProactiveMessage(bot, config, message);
    });
    registerChannelSender("whatsapp", async (message) => {
        await sendWhatsAppProactiveMessage(message);
    });
    registerChannelSender("discord", async (message) => {
        await sendDiscordProactiveMessage(message);
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

            // Always send push notification if subscriptions exist
            if (getSubscriptionCount() > 0) {
                sendPushNotification("A.T.L.A.S", message.substring(0, 180)).catch(() => {});
            }
        },
    });

    // ── Scheduled Tasks ───────────────────────
    setTaskTriggerHandler(async (taskId: string, action: string) => {
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
