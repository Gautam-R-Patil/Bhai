// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import "./security/log-redaction.js"; // first: redacts secrets/PII from every log line
import { join } from "node:path";
import { checkAccountStatus, initAccountGuard } from "./account-guard.js";
import { runAgent } from "./agent.js";
import { autoResumeInterruptedTasks } from "./agents/long-task.js";
import { closeCanvas, initCanvas } from "./canvas/server.js";
import { getDataDir } from "./config/paths.js";
import { loadConfig } from "./config.js";
import { loadJobs } from "./cron/store.js";
import { startCronTicker, stopCronTicker } from "./cron/tick.js";
import { closeDiscord, initDiscord, sendDiscordProactiveMessage } from "./discord.js";
import { closeEmail, initEmail } from "./email.js";
import { initForge } from "./forge/orchestrator.js";
import { initRegistry } from "./harness/registry.js";
import { createLLMClient } from "./llm.js";
import { initLocationService, onLocationChange, refreshLocation } from "./location/index.js";
import { startNetworkWatcher, stopNetworkWatcher } from "./location/network-watcher.js";
import { closeMatrix, initMatrix, sendMatrixProactiveMessage } from "./matrix.js";
import { closeBhaiMail, initBhaiMail } from "./bhai-mail.js";
import { closeMCPServers, initMCPServers } from "./mcp/client.js";
import { initCounterfactualMemory } from "./memory/counterfactual.js";
import { embedText, warmup as warmupEmbeddings } from "./memory/embeddings.js";
import { initEmotionalMemory } from "./memory/emotional.js";
import { initEpisodicMemory } from "./memory/episodic.js";
import { initGoals } from "./memory/goals.js";
import { getIdentityProfile, initIdentityDB, updateIdentityProfile } from "./memory/identity.js";
import { initKnowledgeGraph } from "./memory/knowledge-graph.js";
import { runDailyDecay, runDreamReplay } from "./memory/reflection.js";
import { initRelationshipState } from "./memory/relationship.js";
import { initSelfStateDB } from "./memory/self-state.js";
import { embedExistingMemories, initMemoryDB, setMemoryLLM } from "./memory/sqlite.js";
import { initStrategyLibrary } from "./memory/strategy-library.js";
import { initSupabase } from "./memory/supabase.js";
import { initTaskLearnings } from "./memory/task-learnings.js";
import { initTraitsDB, setMemoryDebug } from "./memory/traits.js";
import { initWorkingMemory } from "./memory/working-memory.js";
import {
    getOnlineNotificationMessage,
    onNetworkStatusChange,
    startNetworkMonitor,
    stopNetworkMonitor,
} from "./network-health.js";
import { getSubscriptionCount, sendPushNotification } from "./notifications/push.js";
import { closeOverlayChat, initOverlayChat, sendOverlayNotification } from "./overlay/overlay-chat.js";
import { startHeartbeat, stopHeartbeat } from "./proactive/heartbeat.js";
import { initCredibilityModel } from "./research/credibility-model.js";
import { initSandbox } from "./security/sandbox.js";
import { loggableRejection } from "./security/vm-isolate.js";
import { initSession, revokeCurrentSession, sessionNeedsSignIn } from "./session.js";
import { seedProfileIfPresent } from "./setup/wizard-seed.js";
import { initSkillMetadata } from "./skills/loader.js";
import { closeSlack, initSlack, sendSlackProactiveMessage } from "./slack.js";
import { createTelegramBot, sendProactiveMessage } from "./telegram.js";
import { initToolRouter, setToolRouterLLM } from "./tool-router.js";
import {
    closeBrowser,
    closeChromeBridge,
    initActionCache,
    initChromeBridge,
    registerChromeBackend,
    registerPlaywrightBackend,
} from "./tools/browser/index.js";
import { initBrowserMemory } from "./tools/browser-memory.js";
import { initGoogleAPI } from "./tools/google-api.js";
import {
    executeTool,
    getToolNames,
    initDeepResearch,
    loadDynamicTools,
    registerChannelSender,
    rotateAuditLog,
    setBrandAuditLLM,
    setCampaignPlannerLLM,
    setCaptchaLLM,
    setCodeActionExecutor,
    setCodeActionLLM,
    setComputerUseLLM,
    setDeepResearchLLM,
    setDeepResearchNotifier,
    setIngestLLM,
    setLongTaskLLM,
    setOutreachLLM,
    setPresentationLLM,
    setProductHuntLLM,
    setScriptWriterLLM,
    setSiteMintLLM,
    setSmartClickLLM,
    setSwarmLLM,
} from "./tools/index.js";
import { setTaskTriggerHandler } from "./tools/scheduled.js";
import { initSpotify } from "./tools/spotify.js";
import { probeAndLogMacPermissions } from "./utils/macos-permissions.js";
import { getPlatformCapabilities } from "./utils/platform-capabilities.js";
import { closeWhatsApp, initWhatsApp, sendWhatsAppProactiveMessage } from "./whatsapp.js";

// ── Primary Channel ──────────────────────────
const PRIMARY_CHANNEL = process.env.PRIMARY_CHANNEL || "telegram";

// ── Banner ────────────────────────────────────

console.log(`
  ╔══════════════════════════════════════╗
  ║       🤖 Bhai v0.2.0            ║
  ║   Personal AI Agent · All Systems    ║
  ╚══════════════════════════════════════╝
`);

// ── Boot ──────────────────────────────────────

const config = loadConfig();
const llm = createLLMClient(config);
setSwarmLLM(llm); // Inject into swarm tool
setToolRouterLLM(llm); // Inject into tool router for LLM intent classification
setDeepResearchLLM(llm); // Inject into deep research tool
setLongTaskLLM(llm); // Inject into long task executor
setCodeActionLLM(llm); // Inject into code-as-action agent tool
setCodeActionExecutor(executeTool); // Inject tool executor for code_execute sandbox
setComputerUseLLM(llm); // Inject into computer use agent tool
setSmartClickLLM(llm); // Inject into os_smart_click cloud-grounding cascade tier
setSiteMintLLM(llm); // Inject into the Site Skill Minter (site_skill_mint)
setCaptchaLLM(llm); // Inject into the picture-CAPTCHA vision solver
setMemoryLLM(llm); // Inject into memory for smart write decisions
setPresentationLLM(llm); // Inject into presentation generator
setIngestLLM(llm); // Inject into PDF → JSON ingestion (vision-LLM fallback)
setBrandAuditLLM(llm); // Inject into brand audit orchestrator
setScriptWriterLLM(llm); // Inject into marketing script writer
setCampaignPlannerLLM(llm); // Inject into campaign planner
setOutreachLLM(llm); // Inject into cold outreach engine
setProductHuntLLM(llm); // Inject into Product Hunt launch module

// ── Initialize Subsystems ─────────────────────

async function boot() {
    // ── Codebase self-protection ──
    // Pin the bot's own source tree as a protected path. Write/delete tools
    // refuse to touch anything under it; absent a registered path the
    // protection silently no-ops (PROTECTED_PATHS is empty by default
    // because we no longer ship a developer-machine path in the binary).
    try {
        const { registerProtectedPath } = await import("./security/allowlist.js");
        const { fileURLToPath } = await import("node:url");
        const path = await import("node:path");
        // Resolve up from dist/index.js (or src/index.ts in dev) to the bot root.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const botRoot = path.resolve(here, "..");
        registerProtectedPath(botRoot);
        registerProtectedPath(process.cwd());
        // Mirror to native Rust state if the helper is exported.
        try {
            const native: any = await import("../native/index.js" as string);
            if (typeof native?.addProtectedPath === "function") {
                native.addProtectedPath(botRoot);
                native.addProtectedPath(process.cwd());
            }
        } catch {
            /* native helper optional */
        }
    } catch (err) {
        console.warn("[BOOT] registerProtectedPath skipped:", (err as Error).message);
    }

    // Saved secrets from the desktop app's vault arrive on stdin (security/vault.ts).
    const { initVault } = await import("./security/vault.js");
    initVault();

    // ── Session (must run first — creates auth token for all Convex calls) ──
    // Retry up to 3 times with backoff for transient network failures
    let sessionOk = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        sessionOk = await initSession();
        if (sessionOk) break;
        if (sessionNeedsSignIn()) {
            // 78: not allowed to run — the app shows "sign in again" and won't auto-restart.
            console.error("❌ This device needs to sign in again (Account in the Bhai app)");
            process.exit(78);
        }
        if (attempt < 3) {
            const delay = attempt * 3000;
            console.warn(`⚠️  Session creation failed (attempt ${attempt}/3) — retrying in ${delay / 1000}s...`);
            await new Promise((r) => setTimeout(r, delay));
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
            refreshLocation().catch(() => {
                /* non-fatal */
            });
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
        // Once per install: mask secrets in conversation text saved before at-rest masking.
        setImmediate(() => {
            import("./memory/at-rest-scrub.js")
                .then(async ({ scrubSecretsAtRest }) => {
                    const { getRawDb } = await import("./memory/sqlite.js");
                    const raw = getRawDb();
                    const n = raw ? scrubSecretsAtRest(raw) : null;
                    if (n) console.log(`🔐 Masked secrets saved before at-rest masking: ${JSON.stringify(n)}`);
                })
                .catch((err) => console.warn("[memory] at-rest scrub skipped:", (err as Error).message));
        });
        initKnowledgeGraph(memDb);
        initCredibilityModel(memDb);
        initIdentityDB(memDb);
        initTraitsDB(memDb);

        // Local self-improvement draft buffer (drains nightly to server)
        const { initSelfImprovementDrafts } = await import("./memory/self-improvement-drafts.js");
        initSelfImprovementDrafts(memDb);

        // Deep-research boot recovery — must run after data dir is created
        // by initMemoryDB. Marks any "running" entries from the prior process
        // as "interrupted" so the agent surfaces them honestly on next turn.
        await initDeepResearch();

        // Seed identity from the setup wizard's `.user-profile.json` (if present).
        // Idempotent across restarts — renames source to `.user-profile.seeded.json`
        // after successful seed. Source lives in the Electron app's userData dir,
        // exposed to the bot via ATLAS_USER_DATA_DIR; falls back to ATLAS_DATA_DIR.
        try {
            const seedResult = seedProfileIfPresent(
                {
                    userDataDir: process.env.ATLAS_USER_DATA_DIR,
                    dataDir: process.env.ATLAS_DATA_DIR,
                },
                { log: (m) => console.log(m) },
            );
            if (seedResult.ran) {
                console.log(`🌱 Wizard profile seeded: ${seedResult.seeded?.name}`);
            }
        } catch (err) {
            console.warn("[wizard-seed] non-fatal error:", (err as Error).message);
        }

        // Push the wizard's name to Convex accounts.name. OTPless doesn't
        // include a display name in its identity payload, so without this
        // the admin panel renders every user as "Unnamed User".
        // upsertAccountInternal is a no-op when the value already matches,
        // so this is safe to call on every boot.
        try {
            const { syncAccountNameIfPresent } = await import("./setup/account-name-sync.js");
            const r = await syncAccountNameIfPresent({
                userDataDir: process.env.ATLAS_USER_DATA_DIR,
                dataDir: process.env.ATLAS_DATA_DIR,
            });
            if (r.ran) {
                console.log(`👤 Account name synced to server: ${r.name}`);
            } else if (r.reason === "push-failed") {
                console.warn("[account-name-sync] push failed:", r.error);
            }
        } catch (err) {
            console.warn("[account-name-sync] non-fatal error:", (err as Error).message);
        }

        // Sync user-chosen personality preset to server addendum
        // (slug: "user-personality"). Idempotent — renames source after push.
        try {
            const { syncPersonalityIfPresent } = await import("./setup/personality-sync.js");
            const r = await syncPersonalityIfPresent({
                userDataDir: process.env.ATLAS_USER_DATA_DIR,
                dataDir: process.env.ATLAS_DATA_DIR,
            });
            if (r.ran) {
                console.log(`🎨 Personality preset synced to server (v${r.version})`);
            } else if (r.reason && r.reason !== "no-file") {
                console.warn(`[personality-sync] ${r.reason}${r.error ? `: ${r.error}` : ""}`);
            }
            // Later Settings changes apply on the next message, not the next boot.
            const { watchPersonalityFile, loadActivePreset } = await import("./setup/personality-sync.js");
            loadActivePreset({ userDataDir: process.env.ATLAS_USER_DATA_DIR, dataDir: process.env.ATLAS_DATA_DIR });
            watchPersonalityFile(
                { userDataDir: process.env.ATLAS_USER_DATA_DIR, dataDir: process.env.ATLAS_DATA_DIR },
                (res) => {
                    if (res.ran) console.log(`🎨 Personality updated from Settings (v${res.version})`);
                    else if (res.reason !== "no-file")
                        console.warn(`[personality-sync] ${res.reason}${res.error ? `: ${res.error}` : ""}`);
                },
            );
        } catch (err) {
            console.warn("[personality-sync] non-fatal:", (err as Error).message);
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
            // PASTE pattern speculator records tool sequences so future turns
            // can predict the next likely tool. Observation-only for now —
            // speculative pre-execution stays unwired until the latency/cost
            // tradeoff is validated. Kill with ATLAS_NO_PATTERN_SPECULATOR=true.
            if (process.env.ATLAS_NO_PATTERN_SPECULATOR !== "true") {
                try {
                    const { initPatternSpeculator } = await import("./execution/pattern-speculator.js");
                    initPatternSpeculator(memDb);
                } catch (err) {
                    console.warn("[PASTE] init failed (non-fatal):", (err as Error).message);
                }
            }
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
            const { initNotificationTracker, isFatigued } = await import("./proactive/notification-tracker.js");
            initNotificationTracker(memDb);
            // Wire the fatigue gate into proactive dispatch so we stop
            // sending when the user isn't engaging recently.
            const { registerFatigueCheck } = await import("./proactive/dispatch.js");
            registerFatigueCheck(isFatigued);
        } catch (ntErr) {
            console.warn("[BOOT] Notification tracker init failed (non-fatal):", (ntErr as Error).message);
        }
    } catch (err) {
        console.warn("\n⚠️ [BOOT] FAILED TO INITIALIZE MEMORY DATABASE");
        console.warn("⚠️ Native module (better-sqlite3) could not be loaded. Bhai will run without memory persistence.");
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
        initMCPServers().catch((e) => console.warn("[BOOT] MCP:", (e as Error).message)),
        // Skills (fetch metadata from server — instructions stay server-side)
        initSkillMetadata().catch((e) => console.warn("[BOOT] Skills:", (e as Error).message)),
        // Load persisted dynamic tools (created by create_tool with persistent=true)
        loadDynamicTools().catch((e) => console.warn("[BOOT] Dynamic tools:", (e as Error).message)),
        // Skill Forge (Phase 1) — kill switch: ATLAS_NO_FORGE=true
        initForge({ embedFn: embedText }).catch((e) => console.warn("[BOOT] Forge:", (e as Error).message)),
        // Hooks (user + project ~/.atlas/hooks.json and .atlas/hooks.json)
        import("./hooks/index.js")
            .then((mod) => mod.loadHooks())
            .catch((e) => console.warn("[BOOT] Hooks:", (e as Error).message)),
        // Tool intelligence: rotate audit log on boot (keep last 7 days)
        rotateAuditLog().catch((e) => console.warn("[BOOT] Audit log rotation:", (e as Error).message)),
        // Canvas (WebSocket)
        Promise.resolve()
            .then(() => initCanvas())
            .catch((e) => console.warn("[BOOT] Canvas:", (e as Error).message)),
        // Google APIs (load saved accounts)
        Promise.resolve()
            .then(() => initGoogleAPI())
            .catch((e) => console.warn("[BOOT] Google API:", (e as Error).message)),
        // Spotify (load saved tokens)
        Promise.resolve()
            .then(() => initSpotify())
            .catch((e) => console.warn("[BOOT] Spotify:", (e as Error).message)),
        // Overlay chat (desktop "Type to Bhai")
        Promise.resolve()
            .then(() => initOverlayChat(llm))
            .catch((e) => console.warn("[BOOT] Overlay:", (e as Error).message)),
        // Email channel (IMAP listener + SMTP sender)
        initEmail(llm, config).catch((e) => console.warn("[BOOT] Email:", (e as Error).message)),
        // Bhai's own email (<name>.bhai@xagilab.com) — only if BHAI_MAIL_ADDRESS is set
        Promise.resolve().then(() => initBhaiMail(llm)),
        // Slack bot (Socket Mode — only if SLACK_BOT_TOKEN is set)
        initSlack(llm).catch((e) => console.warn("[BOOT] Slack:", (e as Error).message)),
        // WhatsApp channel (Baileys QR pairing — only if WHATSAPP_ALLOWED_JIDS is set)
        initWhatsApp(llm).catch((e) => console.warn("[BOOT] WhatsApp:", (e as Error).message)),
        // Discord bot (slash commands + @mention — only if DISCORD_BOT_TOKEN is set)
        initDiscord(llm).catch((e) => console.warn("[BOOT] Discord:", (e as Error).message)),
        // Matrix/Element bot (CS API long-poll — only if MATRIX_HOMESERVER is set)
        initMatrix(llm).catch((e) => console.warn("[BOOT] Matrix:", (e as Error).message)),
        // Location service (GPS → Wi-Fi → IP fallback chain)
        initLocationService().catch((e) => console.warn("[BOOT] Location:", (e as Error).message)),
    ]);

    // Location: start SSID watcher + hook into network recovery
    startNetworkWatcher();

    // Record the device location on the identity profile as current_location.
    // Never touch `location`: that is where the user said they live, and a
    // trip or a VPN exit must not overwrite it.
    onLocationChange((data) => {
        try {
            const locationStr = [data.city, data.region, data.countryName || data.country].filter(Boolean).join(", ");
            if (locationStr && getIdentityProfile().current_location !== locationStr) {
                updateIdentityProfile({ current_location: locationStr });
                console.log(`[LOCATION] Current location: ${locationStr}`);
            }
        } catch {
            /* identity not initialized */
        }
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
        .catch((err) =>
            console.warn(
                "[BOOT] Embedding warmup failed (non-fatal — will load on first use):",
                (err as Error).message,
            ),
        );

    // Semantic embeddings migration (async, non-blocking — runs in background)
    embedExistingMemories().catch((err) => console.warn("[BOOT] Embedding migration failed (non-fatal):", err));

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
                    console.log(
                        `   Migrate : ${result.migrated} embeddings re-embedded (${result.remaining} remaining)`,
                    );
                }
            }
        } catch (migErr) {
            console.warn("[BOOT] Embedding version migration failed (non-fatal):", (migErr as Error).message);
        }
    })();

    // Smart tool router (pre-compute category embeddings — async, non-blocking)
    initToolRouter().catch((err) =>
        console.warn("[BOOT] Tool router init failed (non-fatal, will use structural fallback):", err),
    );

    // Warm up platform capability probe (non-blocking)
    if (process.env.ATLAS_SKIP_CAPABILITY_PROBE !== "true") {
        getPlatformCapabilities().catch((err) => console.warn("[boot] capability probe failed:", err));
    }

    // macOS-only — probe Accessibility + Screen Recording for real, with actionable
    // advice when the user thinks they granted permission but the bot can't actually use it.
    if (process.platform === "darwin" && process.env.ATLAS_SKIP_PERMISSION_PROBE !== "true") {
        probeAndLogMacPermissions().catch((err) => console.warn("[boot] permission probe failed:", err));
    }

    // Auto-resume any long tasks that were interrupted (async, non-blocking)
    autoResumeInterruptedTasks(llm)
        .then(({ resumed }) => {
            if (resumed.length > 0) {
                console.log(`   Tasks  : ${resumed.length} interrupted task(s) auto-resumed`);
            }
        })
        .catch((err) => console.warn("[BOOT] Long task auto-resume failed (non-fatal):", err));

    // ── Create Telegram Bot (optional) ────────
    // bot is null when TELEGRAM_BOT_TOKEN / ALLOWED_USER_IDS aren't configured.
    // The rest of the system (overlay, desktop, WhatsApp, Discord, etc.) runs
    // without it. All Telegram-specific code paths are gated on `bot != null`.
    const bot = config.telegramEnabled ? createTelegramBot(config, llm) : null;

    // ── Register cross-channel senders (for send_message_on_channel tool) ──
    if (bot) {
        registerChannelSender("telegram", (message, filePath, buttons, ownerOnly) =>
            sendProactiveMessage(bot, config, message, filePath, buttons, ownerOnly),
        );
    }
    registerChannelSender("whatsapp", (message, filePath) => sendWhatsAppProactiveMessage(message, filePath));
    registerChannelSender("discord", (message, filePath) => sendDiscordProactiveMessage(message, filePath));
    registerChannelSender("slack", (message) => sendSlackProactiveMessage(message));
    registerChannelSender("matrix", (message) => sendMatrixProactiveMessage(message));
    registerChannelSender("overlay", (message) => sendOverlayNotification(message));

    // Wire deep research proactive notifier (background research sends progress here)
    setDeepResearchNotifier(async (msg: string) => {
        // Primary channel gets the message first
        const sendPrimary: Record<string, () => Promise<unknown>> = {
            whatsapp: () => sendWhatsAppProactiveMessage(msg),
            discord: () => sendDiscordProactiveMessage(msg),
            slack: () => sendSlackProactiveMessage(msg),
            matrix: () => sendMatrixProactiveMessage(msg),
            overlay: () => {
                sendOverlayNotification(msg);
                return Promise.resolve();
            },
        };
        if (bot) sendPrimary.telegram = () => sendProactiveMessage(bot, config, msg);

        // Send to primary channel
        const primaryFn = sendPrimary[PRIMARY_CHANNEL];
        if (primaryFn) {
            try {
                await primaryFn();
            } catch {
                /* primary failed, will try others */
            }
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
    console.log(
        `   Telegram: ${config.telegramEnabled ? `${config.allowedUserIds.size} allowed user(s)` : "disabled"}`,
    );
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
                    // No push here: dispatch.ts pushes what is actually delivered.
                    obs.enqueue(intentFromThought(message, { hourNow: new Date().getHours() }));
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
                const { getToneReminder } = await import("./setup/personality-sync.js");
                const { dispatchProactiveMessage } = await import("./proactive/dispatch.js");
                const intent = intentFromThought(message, { hourNow: new Date().getHours() });
                const channelOrder: Array<"telegram" | "whatsapp" | "discord" | "slack" | "matrix" | "overlay"> = [
                    "telegram",
                    "whatsapp",
                    "discord",
                    "slack",
                    "matrix",
                    "overlay",
                ];
                // The Observer holds quiet hours and picks one channel; without it, keep both:
                // nothing in the night window, and the thought goes to ONE channel (it used to
                // go to every channel at once, at any hour).
                const { inWindow, loadProactiveConfig } = await import("./proactive/config.js");
                const cfg = loadProactiveConfig(join(getDataDir(), "proactive-config.json"));
                if (cfg.quiet || inWindow(cfg.nightWindows.default)) return;
                const primary = channelOrder.find((c) => c === PRIMARY_CHANNEL);
                for (const channel of primary
                    ? [primary, ...channelOrder.filter((c) => c !== primary)]
                    : channelOrder) {
                    try {
                        const composed = await compose(intent, channel, { tone: getToneReminder() ?? "warm" }, [], {
                            llm,
                        });
                        if (
                            composed &&
                            (await dispatchProactiveMessage(
                                channel,
                                composed.text,
                                composed.modeTag,
                                undefined,
                                false,
                                intent.urgency === "urgent",
                            ))
                        )
                            break;
                    } catch (err) {
                        // e.g. no sender registered for this channel: try the next one
                        console.log(`proactive dispatch failed (${channel}):`, (err as Error).message);
                    }
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
                configPath: join(getDataDir(), "proactive-config.json"),
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
                    console.log("💓 Inbox manager ready (%d pending)", manager.listPending().length);

                    // Periodic expiry sweep (every hour; items older than 7d expire)
                    const EXPIRY_MS = 7 * 24 * 60 * 60_000;
                    const _expireT = setInterval(() => {
                        manager.expireOlderThan(EXPIRY_MS);
                    }, 60 * 60_000);
                    _expireT.unref?.();

                    // Periodic deferred-ready sweep (every minute)
                    const _readyT = setInterval(() => {
                        manager.readyDeferred();
                    }, 60_000);
                    _readyT.unref?.();
                } else {
                    console.log("[BOOT] InboxManager skipped: no raw DB handle");
                }
            } catch (err) {
                console.log("[BOOT] InboxManager init failed (non-fatal):", (err as Error).message);
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
                obs.registerSource(
                    makeMemoryAnticipationSource({
                        tick: async (ctxIn) => innerTick(ctxIn),
                        embedText: async (t) => await embedText(t, "query"),
                        getPresence: () => getUserPresence(),
                    }),
                );
                console.log("💓 Registered source: memory_anticipation");
            } catch (err) {
                console.log(
                    "[BOOT] memory_anticipation source registration failed (non-fatal):",
                    (err as Error).message,
                );
            }

            // ── Register long_task_status source (Phase 3 Task 3.3) ──
            try {
                const { makeLongTaskStatusSource } = await import("./proactive/sources/long-task-status.js");
                obs.registerSource(makeLongTaskStatusSource());
                console.log("💓 Registered source: long_task_status");
            } catch (err) {
                console.log("[BOOT] long_task_status source registration failed (non-fatal):", (err as Error).message);
            }

            // ── Register onboarding_graduation source (W3) ──
            // Fires Day-2 / Day-3 / Day-5 wizard graduation nudges.
            // ATLAS_NO_ONBOARDING_NUDGES=true short-circuits the source itself.
            try {
                const { onboardingGraduationSource } = await import("./proactive/sources/onboarding-graduation.js");
                obs.registerSource(onboardingGraduationSource);
                console.log("💓 Registered source: onboarding_graduation");
            } catch (err) {
                console.log(
                    "[BOOT] onboarding_graduation source registration failed (non-fatal):",
                    (err as Error).message,
                );
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
                const { makeLatentTopicMonitorSource } = await import("./proactive/sources/latent-topic-monitor.js");
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
                    console.log(`💓 Loaded ${activeRules.length} monitor rule(s) into Rust matcher`);
                }
                obs.registerSource(makeLatentTopicMonitorSource());
                console.log("💓 Registered source: latent_topic_monitor");
            } catch (err) {
                console.log(
                    "[BOOT] latent_topic_monitor source registration failed (non-fatal):",
                    (err as Error).message,
                );
            }

            try {
                const { COMMITMENT_DUE } = await import("./proactive/sources/commitment-due.js");
                obs.registerSource(COMMITMENT_DUE);
                console.log("💓 Registered source: commitment_due");
            } catch (err) {
                console.log("[BOOT] commitment_due registration failed (non-fatal):", (err as Error).message);
            }

            try {
                const { MEMORY_DIGEST } = await import("./proactive/sources/memory-digest.js");
                obs.registerSource(MEMORY_DIGEST);
                console.log("💓 Registered source: memory_digest");
            } catch (err) {
                console.log("[BOOT] memory_digest registration failed (non-fatal):", (err as Error).message);
            }

            // ── V3 sources (default ON; set ATLAS_PROACTIVE_V3_SOURCES=false to disable) ──
            if (process.env.ATLAS_PROACTIVE_V3_SOURCES !== "false") {
                const webSearch = async (query: string): Promise<string> => {
                    try {
                        return await executeTool("web_search", { query });
                    } catch {
                        return "";
                    }
                };

                try {
                    const { CALENDAR_MORNING } = await import("./proactive/sources/calendar-morning.js");
                    obs.registerSource(CALENDAR_MORNING);
                    console.log("💓 Registered source: calendar_morning (V3)");
                } catch (err) {
                    console.log("[BOOT] calendar_morning registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { CALENDAR_PREP } = await import("./proactive/sources/calendar-prep.js");
                    obs.registerSource(CALENDAR_PREP);
                    console.log("💓 Registered source: calendar_prep (V3)");
                } catch (err) {
                    console.log("[BOOT] calendar_prep registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { MEETING_FOLLOWUP } = await import("./proactive/sources/meeting-followup.js");
                    obs.registerSource(MEETING_FOLLOWUP);
                    console.log("💓 Registered source: meeting_followup (V3)");
                } catch (err) {
                    console.log("[BOOT] meeting_followup registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { TASKS_MORNING } = await import("./proactive/sources/tasks-morning.js");
                    obs.registerSource(TASKS_MORNING);
                    console.log("💓 Registered source: tasks_morning (V3)");
                } catch (err) {
                    console.log("[BOOT] tasks_morning registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { TASKS_DEADLINE } = await import("./proactive/sources/tasks-deadline.js");
                    obs.registerSource(TASKS_DEADLINE);
                    console.log("💓 Registered source: tasks_deadline (V3)");
                } catch (err) {
                    console.log("[BOOT] tasks_deadline registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { GOALS_MORNING } = await import("./proactive/sources/goals-morning.js");
                    obs.registerSource(GOALS_MORNING);
                    console.log("💓 Registered source: goals_morning (V3)");
                } catch (err) {
                    console.log("[BOOT] goals_morning registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { HABIT_ANOMALY } = await import("./proactive/sources/habit-anomaly.js");
                    obs.registerSource(HABIT_ANOMALY);
                    console.log("💓 Registered source: habit_anomaly (V3)");
                } catch (err) {
                    console.log("[BOOT] habit_anomaly registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { makeWeatherMorningSource } = await import("./proactive/sources/weather-morning.js");
                    obs.registerSource(makeWeatherMorningSource({ llm, webSearch }));
                    console.log("💓 Registered source: weather_morning (V3)");
                } catch (err) {
                    console.log("[BOOT] weather_morning registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { makeNewsMorningSource } = await import("./proactive/sources/news-morning.js");
                    obs.registerSource(makeNewsMorningSource({ llm, webSearch }));
                    console.log("💓 Registered source: news_morning (V3)");
                } catch (err) {
                    console.log("[BOOT] news_morning registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { STALE_EMAIL } = await import("./proactive/sources/stale-email.js");
                    obs.registerSource(STALE_EMAIL);
                    console.log("💓 Registered source: stale_email (V3)");
                } catch (err) {
                    console.log("[BOOT] stale_email registration failed (non-fatal):", (err as Error).message);
                }

                try {
                    const { DEEP_WORK_GAP } = await import("./proactive/sources/deep-work-gap.js");
                    obs.registerSource(DEEP_WORK_GAP);
                    console.log("💓 Registered source: deep_work_gap (V3)");
                } catch (err) {
                    console.log("[BOOT] deep_work_gap registration failed (non-fatal):", (err as Error).message);
                }
            } else {
                console.log("💓 V3 sources disabled (ATLAS_PROACTIVE_V3_SOURCES=false)");
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
        const sendPrimary: Record<string, () => Promise<unknown>> = {
            whatsapp: () => sendWhatsAppProactiveMessage(message),
            discord: () => sendDiscordProactiveMessage(message),
            slack: () => sendSlackProactiveMessage(message),
            matrix: () => sendMatrixProactiveMessage(message),
            overlay: () => {
                sendOverlayNotification(message);
                return Promise.resolve();
            },
        };
        if (bot) sendPrimary.telegram = () => sendProactiveMessage(bot, config, message);

        // Send to primary channel
        const primaryFn = sendPrimary[PRIMARY_CHANNEL];
        if (primaryFn) {
            try {
                await primaryFn();
            } catch {
                /* primary failed, will try others */
            }
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

        // Memory over time (24h soak: must stay under 1GB). One line per 10 min.
        const _memT = setInterval(
            () => {
                const m = process.memoryUsage();
                const line = {
                    t: new Date().toISOString(),
                    rssMb: Math.round(m.rss / 1e6),
                    heapMb: Math.round(m.heapUsed / 1e6),
                };
                import("node:fs")
                    .then(({ appendFileSync }) =>
                        appendFileSync(join(getDataDir(), "mem.jsonl"), `${JSON.stringify(line)}\n`),
                    )
                    .catch(() => {});
            },
            10 * 60 * 1000,
        );
        _memT.unref?.();

        // First run at 3am, then decay every 6h
        setTimeout(() => {
            runDailyDecay(true);
            runDreamReplay(llm).catch((err) => console.error("[MEMORY][REPLAY] Dream replay failed:", err));
            // Decay runs every 6 hours for cleaner memory; every 4th tick is the 3am pass.
            let decayTick = 0;
            const _decayT = setInterval(
                () => {
                    runDailyDecay(++decayTick % 4 === 0);
                },
                6 * 60 * 60 * 1000,
            );
            _decayT.unref?.();
            // Dream replay stays nightly (24h)
            const _replayT = setInterval(
                () => {
                    runDreamReplay(llm).catch((err) => console.error("[MEMORY][REPLAY] Dream replay failed:", err));
                },
                24 * 60 * 60 * 1000,
            );
            _replayT.unref?.();
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
                        autonomous: true,
                    },
                );
                return response.text;
            },
            deliver: async (job, response) => {
                const channel = job.deliverTo;
                if (!channel || !response) return true;
                if (channel === "telegram") {
                    const {
                        getTelegramBot,
                        getTelegramConfig,
                        sendProactiveMessage: sendTg,
                    } = await import("./telegram.js");
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

    // ── Webhook Server (opt-in via ATLAS_WEBHOOK_PORT=<n>) ──────
    // register_webhook / list_webhooks tools hand out URLs referring to this
    // HTTP endpoint; if the server isn't running the URLs 404. Opt-in because
    // binding a port at boot is usually unwanted — users who need inbound
    // webhooks can set ATLAS_WEBHOOK_PORT (e.g. 18790) to activate.
    const webhookPort = Number(process.env.ATLAS_WEBHOOK_PORT);
    if (Number.isFinite(webhookPort) && webhookPort > 0 && webhookPort < 65536) {
        try {
            const { initWebhookServer, setWebhookHandler } = await import("./tools/webhook.js");
            initWebhookServer(webhookPort);
            setWebhookHandler(async (endpointId, payload) => {
                console.log(`[WEBHOOK] ${endpointId} received`, payload);
            });
            console.log(`   Webhook : listening on 127.0.0.1:${webhookPort}`);
        } catch (err) {
            console.warn("[WEBHOOK] init failed (non-fatal):", (err as Error).message);
        }
    }

    // ── Start Bot (Telegram-only) ─────────────
    if (bot) {
        bot.start({
            onStart: (botInfo) => {
                console.log(`✅ Bot online: @${botInfo.username}`);
                console.log(`   Mode    : long-polling (no HTTP server)`);
                console.log(`   Tools   : ${toolNames.join(", ")}`);
                console.log(`   Send me a message on Telegram to get started!\n`);
            },
        });
    } else {
        console.log(`✅ Bhai online (Telegram disabled)`);
        console.log(`   Tools   : ${toolNames.join(", ")}`);
        console.log(`   Configure Telegram in the Channels tab to enable.\n`);
    }

    // ── Graceful Shutdown ─────────────────────
    async function shutdown(signal: string) {
        console.log(`\n🛑 Received ${signal}, shutting down...`);
        if (bot) bot.stop();
        stopHeartbeat();
        stopNetworkMonitor();
        stopNetworkWatcher();
        stopCronTicker();
        try {
            const { stopWebhookServer } = await import("./tools/webhook.js");
            stopWebhookServer();
        } catch {
            /* never loaded */
        }
        await closeMCPServers();
        await closeBrowser();
        try {
            const { closeSearchBrowser } = await import("./research/engines.js");
            await closeSearchBrowser();
        } catch {
            /* not loaded */
        }
        closeChromeBridge();
        closeCanvas();
        closeOverlayChat();
        closeSlack();
        closeMatrix();
        closeBhaiMail();
        await closeDiscord();
        await closeWhatsApp();
        await closeEmail();
        try {
            const { stopKokoro } = await import("./voice/live/kokoro-tts.js");
            stopKokoro();
        } catch {
            /* never loaded — live voice wasn't used */
        }
        await revokeCurrentSession();
        process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // One stray rejection used to kill the bot for good (Node's default). Log it
    // and keep serving; a real uncaught exception leaves state unknown, so exit
    // non-zero and let the desktop app restart us (main.js backoff).
    process.on("unhandledRejection", (reason) => {
        // A code_action/Forge sandbox can reject with a Proxy; never touch its traps.
        console.error("⚠️ Unhandled rejection (continuing):", loggableRejection(reason));
    });
    process.on("uncaughtException", (err) => {
        console.error("💥 Uncaught exception, exiting for a clean restart:", err.stack ?? err);
        process.exit(1);
    });
}

// ── Run ───────────────────────────────────────

boot().catch((err) => {
    console.error("❌ Boot failed:", err);
    process.exit(1);
});
