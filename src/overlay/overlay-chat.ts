// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Overlay Chat Server ──────────────────────
// HTTP + WebSocket server for the on-screen "Type to A.T.L.A.S" overlay.
// Shares conversation context with Telegram — unified history.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import type { LLMClient } from "../llm.js";
import { runAgent, type MediaAttachment, type ChannelContext } from "../agent.js";
import { classifyQuery } from "../memory/classifier.js";
import { captureScreenshot } from "../tools/platform.js";
import { getUserPresence } from "../proactive/activity.js";
import { getSessionToken } from "../session.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";
import {
    getThinkingPhrase,
    getProgressMessage,
    getErrorMessage,
    categorizeError,
    getVoiceStagePhrase,
    getWaitPhrase,
} from "../alive-ux.js";
import { setOverlayResearchProgress } from "../tools/index.js";
import { getWidgetScript, getWidgetPage, validateWidgetToken } from "../widget/widget.js";
import {
    initPushNotifications,
    getVapidPublicKey,
    registerSubscription,
} from "../notifications/push.js";
import { isA2ARoute, handleA2ARequest } from "../agents/a2a.js";
import { globalInboxBus, getInboxManager, type InboxEvent } from "../proactive/inbox/manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OVERLAY_PORT = 18792;

let httpServer: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let llmClient: LLMClient | null = null;
const overlayClients = new Set<WebSocket>();
let placeholderInterval: ReturnType<typeof setInterval> | null = null;
let activeRecording: ChildProcess | null = null;
let recordingPath: string | null = null;
let nativeOverlayProcess: ChildProcess | null = null;

// ── Initialize ────────────────────────────────

export function initOverlayChat(llm: LLMClient): void {
    llmClient = llm;

    // HTTP server — serves the overlay HTML page
    httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${OVERLAY_PORT}`);

        if (url.pathname === "/" || url.pathname === "/index.html") {
            try {
                const html = readFileSync(join(__dirname, "..", "..", "src", "overlay", "overlay.html"), "utf-8");
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
            } catch {
                // Fallback: try dist path
                try {
                    const html = readFileSync(join(__dirname, "overlay.html"), "utf-8");
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(html);
                } catch {
                    res.writeHead(404);
                    res.end("Overlay not found");
                }
            }
        } else if (url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", clients: overlayClients.size }));

        } else if (url.pathname === "/api/mentions") {
            // Return tool list + home dir for the @ picker
            const { getToolNames } = await import("../tools/index.js");
            const { getLoadedSkills } = await import("../skills/loader.js");
            const { homedir } = await import("node:os");
            const tools = getToolNames().map(name => ({ type: "tool", name, label: name.replace(/_/g, " ") }));
            const skills = getLoadedSkills().map((s: { name: string }) => ({ type: "skill", name: s.name, label: s.name }));
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://127.0.0.1:18792" });
            res.end(JSON.stringify({ tools, skills, homeDir: homedir() }));

        } else if (url.pathname === "/api/browse") {
            // Browse filesystem for @ file/folder picker
            const { homedir: hd } = await import("node:os");
            const dir = url.searchParams.get("dir") || hd();
            try {
                const { readdirSync } = await import("node:fs");
                const entries = readdirSync(dir, { withFileTypes: true })
                    .filter(e => !e.name.startsWith("."))
                    .map(e => ({
                        name: e.name,
                        path: join(dir, e.name),
                        isDir: e.isDirectory(),
                    }))
                    .sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://127.0.0.1:18792" });
                res.end(JSON.stringify({ dir, entries }));
            } catch {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ dir, entries: [] }));
            }
        } else if (url.pathname === "/api/file") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
                res.writeHead(400);
                res.end("Path required");
                return;
            }
            try {
                const { statSync, createReadStream } = await import("node:fs");
                const stat = statSync(filePath);
                if (stat.isFile()) {
                    const ext = filePath.split(".").pop()?.toLowerCase() || "";
                    const mimeTypes: Record<string, string> = {
                        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                        gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
                        mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime"
                    };
                    const contentType = mimeTypes[ext] || "application/octet-stream";
                    res.writeHead(200, {
                        "Content-Type": contentType,
                        "Content-Length": stat.size.toString(),
                        "Access-Control-Allow-Origin": "http://127.0.0.1:18792"
                    });
                    createReadStream(filePath).pipe(res);
                } else {
                    res.writeHead(404);
                    res.end("Not a file");
                }
            } catch (err) {
                res.writeHead(500);
                res.end("Error");
            }
        // ── Widget endpoint: serves embed instructions page ──
        } else if (url.pathname === "/widget") {
            const host = `http://${req.headers.host || `127.0.0.1:${OVERLAY_PORT}`}`;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(getWidgetPage(host));

        // ── Widget JS: self-contained chat widget script ──
        } else if (url.pathname === "/widget.js") {
            const token = url.searchParams.get("token");
            if (!validateWidgetToken(token)) {
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Invalid widget token");
                return;
            }
            const wsUrl = `ws://127.0.0.1:${OVERLAY_PORT}`;
            res.writeHead(200, {
                "Content-Type": "application/javascript; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache",
            });
            res.end(getWidgetScript(wsUrl));

        // ── Push notification subscription endpoint ──
        } else if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            req.on("end", () => {
                try {
                    const subscription = JSON.parse(body);
                    if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Invalid subscription object" }));
                        return;
                    }
                    registerSubscription(subscription);
                    res.writeHead(201, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                } catch {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid JSON" }));
                }
            });
            return; // Don't fall through -- body is read async

        // ── Push notification VAPID public key endpoint ──
        } else if (url.pathname === "/api/push/vapid-key") {
            const key = getVapidPublicKey();
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ publicKey: key }));

        // ── A2A (Agent-to-Agent) protocol endpoints ──
        } else if (isA2ARoute(url.pathname)) {
            if (req.method === "POST") {
                // Read body for POST requests
                let body = "";
                req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
                req.on("end", () => {
                    if (!llmClient) {
                        res.writeHead(503, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Agent not ready" }));
                        return;
                    }
                    const result = handleA2ARequest(req.method!, url.pathname, body, llmClient);
                    res.writeHead(result.status, {
                        "Content-Type": result.contentType,
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(result.body);
                });
                return; // Don't fall through -- body is read async
            } else {
                if (!llmClient) {
                    res.writeHead(503, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Agent not ready" }));
                    return;
                }
                const result = handleA2ARequest(req.method || "GET", url.pathname, null, llmClient);
                res.writeHead(result.status, {
                    "Content-Type": result.contentType,
                    "Access-Control-Allow-Origin": "*",
                });
                res.end(result.body);
            }

        } else {
            res.writeHead(404);
            res.end("Not found");
        }
    });

    // Initialize push notifications (generates/loads VAPID keys)
    try {
        initPushNotifications();
    } catch (err) {
        console.warn("[OVERLAY] Push notification init failed (non-fatal):", (err as Error).message);
    }

    // WebSocket server — real-time chat
    wss = new WebSocketServer({ server: httpServer });

    // ── Inbox event relay: broadcast inbox:* events to all connected clients ──
    globalInboxBus.subscribe((ev: InboxEvent) => {
        const payload =
            ev.kind === "added"
                ? { type: "inbox:item_added", item: inboxItemToWire(ev.item) }
                : ev.kind === "updated"
                    ? { type: "inbox:item_updated", item: inboxItemToWire(ev.item) }
                    : { type: "inbox:expired", count: ev.count };
        const json = JSON.stringify(payload);
        for (const client of overlayClients) {
            if (client.readyState === 1) {
                try { client.send(json); } catch { /* ignore */ }
            }
        }
    });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        // Validate widget token for web-widget connections
        const connUrl = new URL(req.url || "/", `http://127.0.0.1:${OVERLAY_PORT}`);
        const source = connUrl.searchParams.get("source");
        const token = connUrl.searchParams.get("token");

        if (source === "web-widget" && !validateWidgetToken(token)) {
            ws.close(4001, "Invalid widget token");
            return;
        }

        const isWidget = source === "web-widget";
        overlayClients.add(ws);
        console.log(`💬 ${isWidget ? "Widget" : "Overlay"} chat connected (${overlayClients.size} client${overlayClients.size > 1 ? "s" : ""})`);

        // Send ready signal
        ws.send(JSON.stringify({ type: "ready" }));

        // Send current inbox state on connect (so a fresh overlay sees pending items)
        try {
            const inbox = getInboxManager();
            if (inbox) {
                const items = inbox.listPending().map(inboxItemToWire);
                ws.send(JSON.stringify({ type: "inbox:state", items }));
            }
        } catch { /* non-fatal */ }

        ws.on("message", async (data) => {
            try {
                const msg = JSON.parse(data.toString());

                // ── Inbox control messages (Task 4.2) ──
                if (typeof msg.type === "string" && msg.type.startsWith("inbox:")) {
                    const inbox = getInboxManager();
                    if (!inbox) {
                        ws.send(JSON.stringify({ type: "inbox:error", error: "inbox not initialized" }));
                        return;
                    }
                    // inbox:refresh doesn't need an id
                    if (msg.type === "inbox:refresh") {
                        const items = inbox.listPending().map(inboxItemToWire);
                        ws.send(JSON.stringify({ type: "inbox:state", items }));
                        return;
                    }
                    const id = typeof msg.id === "string" ? msg.id : undefined;
                    if (!id) {
                        ws.send(JSON.stringify({ type: "inbox:error", error: "missing id" }));
                        return;
                    }
                    if (msg.type === "inbox:approve") {
                        const updated = inbox.approve(id);
                        if (!updated) ws.send(JSON.stringify({ type: "inbox:error", id, error: "not found" }));
                        return;
                    }
                    if (msg.type === "inbox:reject") {
                        const reason = typeof msg.reason === "string" ? msg.reason : undefined;
                        inbox.reject(id, reason);
                        return;
                    }
                    if (msg.type === "inbox:edit") {
                        const newText = typeof msg.newText === "string" ? msg.newText : "";
                        if (!newText) {
                            ws.send(JSON.stringify({ type: "inbox:error", id, error: "missing newText" }));
                            return;
                        }
                        inbox.edit(id, newText);
                        return;
                    }
                    if (msg.type === "inbox:defer") {
                        // Accept either ms-epoch `until` or shorthand `inMs` (ms-from-now)
                        let until = typeof msg.until === "number" ? msg.until : 0;
                        if (!until && typeof msg.inMs === "number") until = Date.now() + msg.inMs;
                        if (!until) {
                            ws.send(JSON.stringify({ type: "inbox:error", id, error: "missing until/inMs" }));
                            return;
                        }
                        inbox.defer(id, until);
                        return;
                    }
                    ws.send(JSON.stringify({ type: "inbox:error", id, error: `unknown ${msg.type}` }));
                    return;
                }

                if (msg.type === "chat" && msg.text) {
                    const messageSource = msg.meta?.source || (isWidget ? "web-widget" : "overlay");
                    console.log(`💬 [${messageSource}] message received`);

                    // Chrome extension bridge: prepend browser context for the agent
                    let messageText = msg.text.trim();
                    if (msg.meta?.source === "chrome-extension") {
                        const browserUrl = msg.meta.url || "";
                        const browserTitle = msg.meta.title || "";
                        const contextPrefix = browserUrl
                            ? `[Browser context: ${browserUrl}${browserTitle ? ` — "${browserTitle}"` : ""}]\n`
                            : "";
                        messageText = `${contextPrefix}${messageText}`;
                        console.log(`🌐 [Chrome Extension] Browser context injected: ${browserUrl}`);
                    }

                    await handleOverlayMessage(ws, messageText);
                } else if (msg.type === "quick_action" && msg.text) {
                    const actionText = msg.text.trim();
                    // Handle feedback actions locally (don't send to agent)
                    if (actionText === "feedback:good" || actionText === "feedback:bad") {
                        const isGood = actionText === "feedback:good";
                        console.log(`📊 [Overlay] User feedback: ${isGood ? "👍 good" : "👎 bad"}`);
                        // Record feedback for learning — both tool analytics and strategy library
                        try {
                            const { recordTaskFeedback } = await import("../tool-router-analytics.js");
                            recordTaskFeedback(isGood);
                            // Also reinforce the most recent strategy
                            const { getTopStrategies, reinforceStrategy } = await import("../memory/strategy-library.js");
                            const recent = getTopStrategies(1);
                            if (recent.length > 0) {
                                reinforceStrategy(recent[0].pattern, isGood);
                            }
                        } catch { /* non-fatal */ }
                        sendToClient(ws, {
                            type: "response",
                            text: isGood ? "thanks! I'll remember that worked well." : "got it — I'll try to do better next time.",
                            toolCalls: 0,
                            quickActions: [],
                            files: [],
                            links: [],
                            widgets: [],
                        });
                        return;
                    }
                    // Regular quick action — send as new chat message
                    console.log(`💬 [Overlay] Quick action: ${actionText}`);
                    await handleOverlayMessage(ws, actionText);
                } else if (msg.type === "file_attach" && msg.name && msg.base64) {
                    // File drag-and-dropped into overlay
                    await handleFileAttachment(ws, msg.name, msg.base64, msg.mimeType || "application/octet-stream", msg.text || "");
                } else if (msg.type === "voice_start") {
                    await startVoiceCapture(ws);
                } else if (msg.type === "voice_stop") {
                    await stopVoiceCapture(ws);
                } else if (msg.type === "voice_live_start") {
                    await handleLiveVoiceStart(ws);
                } else if (msg.type === "voice_live_stop") {
                    await handleLiveVoiceStop(ws);
                }
            } catch (err) {
                console.error("[OVERLAY] Message parse error:", err);
            }
        });

        ws.on("close", () => {
            overlayClients.delete(ws);
            console.log(`💬 Overlay chat disconnected (${overlayClients.size} remaining)`);
        });

        ws.on("error", (err) => {
            console.warn(`💬 Overlay client error:`, (err as Error).message);
            overlayClients.delete(ws);
            try { ws.terminate(); } catch { /* already dead */ }
        });
    });

    httpServer.listen(OVERLAY_PORT, "127.0.0.1", () => {
        console.log(`💬 Overlay chat on http://127.0.0.1:${OVERLAY_PORT}`);
        launchNativeOverlay();
    });

    // ── Persistent Overlay Research Progress ──────
    // This callback persists across agent iterations (unlike _onProgress which is cleared)
    // So background research progress + completion notifications always reach the overlay
    setOverlayResearchProgress(async (msg: string) => {
        if (overlayClients.size === 0) return;
        const isComplete = msg.includes("Deep research complete") || msg.includes("✅") || msg.includes("Research complete");
        for (const client of overlayClients) {
            sendToClient(client, { type: "progress", text: humanizeForOverlay(msg) });
            if (isComplete) {
                // Signal overlay to auto-show and display results prominently
                sendToClient(client, { type: "research_complete", text: msg });
            }
        }
    });

    // ── Context-Aware Placeholder ──────────────
    // Periodically detect frontmost app and update overlay placeholder text
    startPlaceholderBroadcast();
}

// ── Screen-Awareness Detection ────────────────

const SCREEN_KEYWORDS = [
    // Explicit screen references
    "screen", "see my", "looking at", "on my screen", "on the screen",
    "what's on", "what is on", "what's here", "whats here",
    "this page", "this app", "this window", "this tab", "current tab",
    "this website", "this web site", "this webpage", "this web page", "this site",
    "can you see", "do you see", "look at",
    // "what is/what's" + deictic
    "what's this", "what is this", "what's that", "what is that",
    "what's open", "what is open", "what am i",
    // How/why questions about something visible
    "how to fix this", "how do i fix this", "how to fix it",
    "how to solve this", "how do i solve", "how to do this",
    "why is this", "why is it", "why does this", "why doesn't this",
    "why isn't this", "why can't i",
    // Help/assist with visible context
    "help me with this", "help with this", "help me fix", "help me understand",
    "help me debug", "help me resolve",
    "what should i do", "what do i do", "what now", "what next",
    "what's happening", "what is happening", "whats happening",
    "what's wrong", "what is wrong", "whats wrong", "what's the problem",
    "what's the issue", "what is the issue", "what's the error", "what is the error",
    // Content analysis
    "read this", "read the", "read it",
    "what does this", "what does it", "what does that",
    "what's it", "what is it", "what does it say", "what is it saying", "what's it saying",
    "tell me about this", "tell me what this",
    "summarize this", "summarise this", "summarize it", "summarise it",
    "summarize the", "summarise the", "summary of this",
    "explain this", "explain it", "explain the",
    "translate this", "translate it", "translate the",
    "analyze this", "analyse this", "analyze it", "analyse it",
    "review this", "review it", "check this",
    "describe this", "describe it",
    "debug this", "fix this", "what's wrong with this",
    "correct this", "proofread this", "edit this",
    "show me", "show what",
];


// Short deictic prompts ("summarize", "explain", "fix") that imply screen context
// when the user doesn't specify WHAT — it means "what's on my screen"
const IMPLICIT_SCREEN_VERBS = [
    "summarize", "summarise", "summary", "explain", "translate",
    "analyze", "analyse", "review", "proofread", "describe",
    "read", "check", "debug", "fix", "correct", "edit", "help",
    "show", "what", "how", "why",
];

// Deictic words — when these appear in a short message, user is pointing at screen
const DEICTIC_WORDS = ["this", "that", "it", "here", "there", "these", "those"];

function isScreenQuery(msg: string): boolean {
    const lower = msg.toLowerCase().trim();
    const words = lower.split(/\s+/);

    // 1. Direct keyword match
    if (SCREEN_KEYWORDS.some(kw => lower.includes(kw))) return true;

    // 2. ANY short message (≤6 words) containing a deictic pronoun probably refers to screen
    //    e.g. "how to fix this", "what is that", "help me with this", "why is it not working"
    if (words.length <= 6 && DEICTIC_WORDS.some(d => words.includes(d))) return true;

    // 3. Short implicit queries starting with a screen-intent verb with no clear object
    //    e.g. "explain", "summarize", "fix it", "debug", "help", "what now"
    if (words.length <= 4) {
        const startsWithVerb = IMPLICIT_SCREEN_VERBS.some(v => lower.startsWith(v));
        if (startsWithVerb) return true;
    }

    // 4. Pure question with no external reference → screen is the implicit context
    //    e.g. "what should I do?", "what's next?", "why is this happening?"
    if (words.length <= 8) {
        const isOpenQuestion = /^(what|why|how|when|where|which|who)\b/i.test(lower);
        const hasNoExternalRef = !/\b(google|youtube|weather|news|wikipedia|github|spotify|telegram|file|folder|path|url|http|www|email|calendar|time|date|remind|alarm|music|song|play|search for|find me|look up)\b/i.test(lower);
        if (isOpenQuestion && hasNoExternalRef && words.length <= 6) return true;
    }

    return false;
}


async function captureScreen(): Promise<{ base64: string; path: string } | null> {
    try {
        const tmpPath = join(tmpdir(), `atlas_screen_${Date.now()}.png`);
        await captureScreenshot(tmpPath);
        const buffer = readFileSync(tmpPath);
        return { base64: buffer.toString("base64"), path: tmpPath };
    } catch (err) {
        console.error("[OVERLAY] Screenshot failed:", (err as Error).message);
        return null;
    }
}

// ── Handle Overlay Message ────────────────────

async function handleOverlayMessage(ws: WebSocket, userMessage: string): Promise<void> {
    if (!llmClient) {
        sendToClient(ws, { type: "error", text: "LLM not initialized" });
        return;
    }

    console.log(`\n💬 [Overlay] User: ${userMessage}`);

    // Send varied "thinking" status using alive-ux
    const thinkingText = getThinkingPhrase("default");
    sendToClient(ws, { type: "thinking", text: `💭 ${thinkingText}` });

    // Track for timeout warnings
    const startTime = Date.now();
    let timeoutWarningTimer: ReturnType<typeof setTimeout> | null = null;

    // Send timeout warning after 30s
    timeoutWarningTimer = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        const waitMsg = getWaitPhrase(elapsed);
        sendToClient(ws, { type: "progress", text: `⏳ ${waitMsg}` });
    }, 30000);

    // Auto-detect screen queries and capture screenshot
    let media: MediaAttachment[] | undefined;
    let taggedMessage = `${userMessage}\n\n[SOURCE: Desktop overlay chat — respond here, NOT on Telegram. Keep your response SHORT and concise — this is a compact overlay, not a full chat. Use 1-3 sentences when possible.]`;

    if (isScreenQuery(userMessage)) {
        console.log("  📸 [Overlay] Screen query detected — capturing screenshot...");
        sendToClient(ws, { type: "progress", text: "📸 Looking at your screen…" });

        const screenshot = await captureScreen();
        if (screenshot) {
            media = [{ type: "image", base64: screenshot.base64, mimeType: "image/png" }];
            taggedMessage = `${userMessage}

[SOURCE: Desktop overlay chat — respond here, NOT on Telegram. Keep responses SHORT (2-4 sentences).

A screenshot of the user's current screen is attached. Use it as your PRIMARY context.

IMPORTANT RULES:
- LOOK at the screenshot carefully before answering
- Answer as if you can naturally see their screen — NO phrases like "based on the screenshot" or "I can see in the image". Just say what's there naturally: "You have X open", "The error says Y", "This is Z"
- If there's an error/code/text on screen, read it and respond specifically to it
- If they ask "what is this" / "how to fix this" / "why" — identify exactly what's on screen and give a direct, specific answer
- Be like a colleague looking over their shoulder — conversational, direct, genuinely helpful]`;
            console.log(`  📸 Screenshot captured (${Math.round(screenshot.base64.length * 0.75 / 1024)}KB)`);
        } else {
            // Screenshot failed (permissions issue etc) — tell user
            taggedMessage = `${userMessage}

[SOURCE: Desktop overlay chat — respond here, NOT on Telegram. Keep responses SHORT.
NOTE: Screenshot capture failed (screen recording permission may be needed). Answer based on conversation context if possible, or ask the user to describe what they are seeing.]`;
        }
    }


    try {
        // Progress callback — sends live updates to the overlay using alive-ux
        const onProgress = async (msg: string) => {
            // Live thinking display — send as special type so overlay can render it differently
            if (msg.startsWith("[THINKING] ")) {
                const thinkingText = msg.slice(11).trim();
                if (thinkingText) {
                    sendToClient(ws, { type: "thinking_content", text: thinkingText });
                }
                return;
            }
            sendToClient(ws, { type: "progress", text: humanizeForOverlay(msg) });
        };

        // Use the SAME shared conversation history (no fork)
        // Fast-path: pass "simple" hint for greetings so model router picks a lighter model
        const overlayHint = !media && classifyQuery(userMessage) === "llm_only" ? "simple" as const : undefined;
        const result = await runAgent(llmClient, taggedMessage, onProgress, media, undefined, undefined, overlayHint, undefined, { channel: "overlay", userId: "local", isOwner: true });

        // Clear timeout warning timer
        if (timeoutWarningTimer) clearTimeout(timeoutWarningTimer);

        console.log(`🤖 [Overlay] A.T.L.A.S: ${result.text.substring(0, 150)}...`);
        console.log(`📡 [Overlay] WS state: ${ws.readyState}, clients: ${overlayClients.size}`);

        // Strip internal debug blocks + [SOURCE: ...] and [no_reply] tags the LLM may have echoed back
        const cleanText = result.text
            .replace(/<system_log>[\s\S]*?<\/system_log>/g, '')
            .replace(/<tool_log[\s\S]*?<\/tool_log>/g, '')
            .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, '')
            .replace(/\[SOURCE:.*?\]/gs, '')
            .replace(/\[no_reply\]/gi, '')
            .trim();

        // Parse interactive elements from response
        const interactive = parseInteractiveElements(cleanText);
        console.log(`📝 [Overlay] Clean text length: ${cleanText.length}, interactive text length: ${interactive.text.length}`);

        if (!interactive.text && interactive.widgets.length === 0 && interactive.files.length === 0 && interactive.links.length === 0 && interactive.quickActions.length === 0) {
            // LLM returned only internal tags (e.g. [NO_REPLY]) — don't leave user hanging
            console.warn(`⚠️ [Overlay] Response stripped to empty — sending fallback`);
            sendToClient(ws, { type: "response", text: "hmm", toolCalls: 0, quickActions: [], files: [], links: [], widgets: [] });
            return;
        }

        // Append feedback quick actions when the agent completed a multi-tool task
        const feedbackActions = result.toolCalls >= 2 ? [
            ...(interactive.quickActions || []),
            { label: "👍", action: "feedback:good" },
            { label: "👎", action: "feedback:bad" },
        ] : (interactive.quickActions || []);

        sendToClient(ws, {
            type: "response",
            text: interactive.text,
            toolCalls: result.toolCalls,
            quickActions: feedbackActions,
            files: interactive.files,
            links: interactive.links,
            widgets: interactive.widgets,
        });
    } catch (err) {
        if (timeoutWarningTimer) clearTimeout(timeoutWarningTimer);
        console.error("[OVERLAY] Agent error:", err);
        const errorType = categorizeError(err as Error);
        sendToClient(ws, { type: "error", text: getErrorMessage(errorType) });
    }
}

// ── Handle File Attachment (drag-and-drop) ────

async function handleFileAttachment(
    ws: WebSocket,
    fileName: string,
    base64: string,
    mimeType: string,
    userText: string,
): Promise<void> {
    if (!llmClient) {
        sendToClient(ws, { type: "error", text: "LLM not initialized" });
        return;
    }

    console.log(`\n📎 [Overlay] File attached: ${fileName} (${mimeType})`);
    sendToClient(ws, { type: "thinking" });

    const isImage = mimeType.startsWith("image/");
    let media: MediaAttachment[] | undefined;
    let fileContext = "";

    if (isImage) {
        media = [{ type: "image", base64, mimeType }];
    } else {
        // For text/code files, decode and include as text
        try {
            const decoded = Buffer.from(base64, "base64").toString("utf-8");
            fileContext = `\n\nFile contents of "${fileName}":\n\`\`\`\n${decoded.substring(0, 8000)}\n\`\`\``;
        } catch {
            fileContext = `\n\n[Could not decode file: ${fileName}]`;
        }
    }

    const prompt = userText
        ? `${userText}${fileContext}\n\n[SOURCE: Desktop overlay chat — file attached: ${fileName}]`
        : `[SOURCE: Desktop overlay chat — respond here, NOT on Telegram. Keep responses SHORT. The user dropped a file: "${fileName}". ${isImage ? "Analyze the image and describe what you see." : `Here is its content:${fileContext}`}]`;

    try {
        const onProgress = async (msg: string) => {
            sendToClient(ws, { type: "progress", text: humanizeForOverlay(msg) });
        };

        const result = await runAgent(llmClient, prompt, onProgress, media, undefined, undefined, undefined, undefined, { channel: "overlay", userId: "local", isOwner: true });
        const cleanText = result.text
            .replace(/<system_log>[\s\S]*?<\/system_log>/g, '')
            .replace(/<tool_log[\s\S]*?<\/tool_log>/g, '')
            .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, '')
            .replace(/\[SOURCE:.*?\]/gs, '')
            .replace(/\[no_reply\]/gi, '')
            .trim();
        const interactive = parseInteractiveElements(cleanText);

        if (!interactive.text && interactive.widgets.length === 0 && interactive.files.length === 0 && interactive.links.length === 0 && interactive.quickActions.length === 0) {
            sendToClient(ws, { type: "silent" });
            return;
        }

        sendToClient(ws, {
            type: "response",
            text: interactive.text,
            toolCalls: result.toolCalls,
            quickActions: interactive.quickActions,
            files: interactive.files,
            links: interactive.links,
            widgets: interactive.widgets,
        });
    } catch (err) {
        console.error("[OVERLAY] File attachment error:", err);
        sendToClient(ws, { type: "error", text: "Could not process the file." });
    }
}

// ── Interactive Element Parser ────────────────

interface InteractiveElements {
    text: string;
    quickActions: string[];
    files: string[];
    links: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    widgets: any[];
}

function parseInteractiveElements(rawText: string): InteractiveElements {
    let text = rawText;
    let quickActions: string[] = [];
    const files: string[] = [];
    const links: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const widgets: any[] = [];

    // Extract <!--WIDGET: {...}--> (multiple)
    const widgetPattern = /<!--\s*WIDGET\s*:\s*(\{.*?\})\s*-->/gs;
    let widgetMatch;
    while ((widgetMatch = widgetPattern.exec(text)) !== null) {
        try {
            widgets.push(JSON.parse(widgetMatch[1]));
        } catch { /* malformed JSON, ignore */ }
    }
    text = text.replace(/<!--\s*WIDGET\s*:\s*\{.*?\}\s*-->/gs, '').trim();

    // Extract <!--QUICK_ACTIONS: ["...","..."]-->  (flexible whitespace)
    const qaMatch = text.match(/<!--\s*QUICK_ACTIONS\s*:\s*(\[.*?\])\s*-->/s);
    if (qaMatch) {
        try {
            quickActions = JSON.parse(qaMatch[1]);
        } catch { /* malformed JSON, ignore */ }
        text = text.replace(qaMatch[0], '').trim();
    }

    // Auto-detect file paths (absolute paths like /Users/... or ~/...)
    const filePattern = /(?:^|\s|`)((?:\/[\w.-]+){2,}(?:\.\w{1,10})?)(?:\s|$|`|,|\.|\))/gm;
    let fileMatch;
    while ((fileMatch = filePattern.exec(text)) !== null) {
        const path = fileMatch[1];
        // Skip common false positives
        if (!path.startsWith('/usr/bin') && !path.startsWith('/etc') &&
            !path.startsWith('/dev') && !path.startsWith('/proc') &&
            !files.includes(path)) {
            files.push(path);
        }
    }
    // Also detect ~/... paths
    const tildePattern = /(?:^|\s|`)(~\/[\w./-]+)(?:\s|$|`|,|\.|\))/gm;
    let tildeMatch;
    while ((tildeMatch = tildePattern.exec(text)) !== null) {
        if (!files.includes(tildeMatch[1])) files.push(tildeMatch[1]);
    }

    // Auto-detect URLs
    const urlPattern = /https?:\/\/[^\s<>"'`,)]+/g;
    let urlMatch;
    while ((urlMatch = urlPattern.exec(text)) !== null) {
        if (!links.includes(urlMatch[0])) links.push(urlMatch[0]);
    }

    // Cap to reasonable limits
    return {
        text,
        quickActions: quickActions.slice(0, 4),
        files: files.slice(0, 3),
        links: links.slice(0, 3),
        widgets: widgets.slice(0, 3),
    };
}

// ── Helpers ───────────────────────────────────

// ── Overlay Visibility Control for Agent ──────
// Called by OS tools (screenshot, click) to temporarily hide the overlay
// so it doesn't appear in screenshots or block mouse clicks.

/** Hide the overlay from view (for screenshots) — sends CSS opacity:0 */
export function hideOverlayForAgent(): void {
    for (const client of overlayClients) {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: "agent_hide" }));
        }
    }
}

/** Show the overlay again after agent action */
export function showOverlayForAgent(): void {
    for (const client of overlayClients) {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: "agent_show" }));
        }
    }
}

function sendToClient(ws: WebSocket, data: unknown): void {
    const json = JSON.stringify(data);
    if (ws.readyState === 1) {
        ws.send(json);
    } else if (overlayClients.size === 1) {
        // Fallback: original ws died (overlay hidden/refocused) and there is exactly
        // one client connected — safe to redirect to it (the reconnected native overlay).
        // When multiple clients are connected (e.g. concurrent sessions or test runners),
        // we drop silently rather than deliver the response to the wrong session.
        for (const client of overlayClients) {
            if (client.readyState === 1) {
                client.send(json);
                break;
            }
        }
    }
}

// ── Inbox helpers (Task 4.2) ──
/** Returns true when at least one overlay client is currently connected. */
export function isOverlayConnected(): boolean {
    return overlayClients.size > 0;
}

// Structural type — loose on purpose so overlay-chat isn't coupled to the
// InboxItem internal shape beyond what the wire payload needs.
type InboxItemLike = {
    intent: {
        id: string;
        source: string;
        mode: string;
        urgency: string;
        topic: string;
        evidence: Array<{ label: string; value: string; source?: string }>;
        suggestedAction?: { summary: string };
    };
    status: string;
    composedText: string;
    editedText?: string;
    executionStatus?: string;
    executionResult?: string;
    deferredUntil?: number;
    createdAt: number;
};

function inboxItemToWire(item: InboxItemLike): Record<string, unknown> {
    return {
        id: item.intent.id,
        source: item.intent.source,
        mode: item.intent.mode,
        urgency: item.intent.urgency,
        topic: item.intent.topic,
        evidence: item.intent.evidence,
        suggestedActionSummary: item.intent.suggestedAction?.summary,
        status: item.status,
        composedText: item.composedText,
        editedText: item.editedText,
        executionStatus: item.executionStatus,
        executionResult: item.executionResult,
        deferredUntil: item.deferredUntil,
        createdAt: item.createdAt,
    };
}

function humanizeForOverlay(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes("still working")) return `⏳ ${getWaitPhrase(15000)}`;

    // Extract target context from milestone messages
    const extractTarget = (msg: string, patterns: RegExp[]): string | null => {
        for (const pat of patterns) {
            const match = msg.match(pat);
            if (match?.[1]) {
                let target = match[1].trim().replace(/\.{3}$/, "").replace(/^["']|["']$/g, "");
                if (target.length > 40) target = target.substring(0, 37) + "…";
                return target;
            }
        }
        return null;
    };

    // Search — use alive-ux
    if (lower.includes("searching") || lower.includes("search") || lower.includes("🔍")) {
        const query = extractTarget(msg, [/[Ss]earching[:\s]*"?([^"]+)"?/i, /🔍\s*(?:Searching[:\s]*)?(.+)/]);
        return getProgressMessage("search", query || undefined);
    }

    // Browse — use alive-ux
    if (lower.includes("browsing") || lower.includes("opening") || lower.includes("navigat") || lower.includes("🌐")) {
        const url = extractTarget(msg, [/(?:Opening|Navigating to|Browsing)\s+(https?:\/\/\S+)/i, /🌐\s*(?:Opening\s+)?(.+)/]);
        if (url) {
            try {
                const domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
                return getProgressMessage("browse", domain);
            } catch { return getProgressMessage("browse", url); }
        }
        return getProgressMessage("browse");
    }

    // Shell — use alive-ux
    if (lower.includes("running") || lower.includes("executing") || lower.includes("command")) {
        const cmd = extractTarget(msg, [/[Rr]unning (?:command[:\s]*)?(.+)/i, /⚙️\s*(?:Running (?:command[:\s]*)?)?(.+)/]);
        return getProgressMessage("code", cmd || undefined);
    }

    if (lower.includes("reading") || lower.includes("analyzing")) {
        const path = extractTarget(msg, [/[Rr]eading[:\s]*(.+)/i, /📖\s*(?:Reading[:\s]*)?(.+)/]);
        const basename = path ? path.split("/").pop() || path : undefined;
        return getProgressMessage("read", basename);
    }

    if (lower.includes("writing") || lower.includes("creating")) return getProgressMessage("write");
    if (lower.includes("screenshot")) return getProgressMessage("screenshot");
    return `💭 ${getThinkingPhrase("default")}`;
}

// ── Send proactive message to overlay ─────────

export function sendOverlayNotification(message: string): void {
    // Gate proactive overlay notifications through Smart DND
    (async () => {
        try {
            const { shouldSuppressMessage } = await import("../proactive/dnd.js");
            const suppress = await shouldSuppressMessage(message);
            if (suppress) {
                console.log("🔕 Proactive overlay notification suppressed by DND");
                return;
            }
        } catch { /* DND check failed — deliver anyway */ }

        const isResearchComplete = message.includes("Deep research complete") || message.includes("research complete") || (message.includes("✅") && message.includes("sources"));
        for (const client of overlayClients) {
            sendToClient(client, { type: "notification", text: message });
            if (isResearchComplete) {
                sendToClient(client, { type: "research_complete", text: message });
            }
        }

        // Record notification for engagement tracking
        try {
            const { recordNotification } = await import("../proactive/notification-tracker.js");
            recordNotification("proactive", message);
        } catch { /* non-fatal */ }
    })();
}

// ── Send image to overlay ─────────────────────

export function sendOverlayImage(base64: string, mimeType: string, caption?: string): void {
    const dataUrl = `data:${mimeType};base64,${base64}`;
    for (const client of overlayClients) {
        sendToClient(client, { type: "image", url: dataUrl, caption: caption || "" });
    }
}

// ── Context-Aware Placeholder ─────────────────

const PLACEHOLDER_MAP: Record<string, string> = {
    "Code": "Ask about this code…",
    "Visual Studio Code": "Ask about this code…",
    "Cursor": "Ask about this code…",
    "Xcode": "Ask about this code…",
    "IntelliJ IDEA": "Ask about this code…",
    "Chrome": "Summarize this page…",
    "Safari": "Summarize this page…",
    "Arc": "Summarize this page…",
    "Firefox": "Summarize this page…",
    "Brave Browser": "Summarize this page…",
    "Calendar": "What's next today?",
    "Slack": "Draft a reply…",
    "Discord": "Draft a reply…",
    "Messages": "Draft a reply…",
    "Mail": "Draft a reply…",
    "Terminal": "Help with this command…",
    "iTerm2": "Help with this command…",
    "Warp": "Help with this command…",
    "Notes": "Help me write…",
    "Pages": "Help me write…",
    "TextEdit": "Help me write…",
    "Notion": "Help me write…",
};

function getPlaceholderForApp(app: string): string {
    // Direct match
    if (PLACEHOLDER_MAP[app]) return PLACEHOLDER_MAP[app];
    // Partial match (e.g. "Google Chrome" matches "Chrome")
    for (const [key, placeholder] of Object.entries(PLACEHOLDER_MAP)) {
        if (app.includes(key) || key.includes(app)) return placeholder;
    }
    return "Ask A.T.L.A.S…";
}

function startPlaceholderBroadcast(): void {
    if (placeholderInterval) clearInterval(placeholderInterval);

    const broadcast = async () => {
        if (overlayClients.size === 0) return;
        try {
            const presence = await getUserPresence();
            const placeholder = getPlaceholderForApp(presence.frontmostApp);
            for (const client of overlayClients) {
                sendToClient(client, { type: "placeholder", text: placeholder });
            }
        } catch { /* non-critical */ }
    };

    // Initial broadcast after 2 seconds, then every 15 seconds
    setTimeout(broadcast, 2000);
    placeholderInterval = setInterval(broadcast, 15_000);
}

// ── Voice Capture ─────────────────────────────

async function startVoiceCapture(ws: WebSocket): Promise<void> {
    // Stop any existing recording
    if (activeRecording) {
        try { activeRecording.kill(); } catch { /* ignore */ }
        activeRecording = null;
    }

    recordingPath = join(tmpdir(), `atlas_voice_${Date.now()}.wav`);
    console.log("[OVERLAY] 🎤 Starting voice capture...");

    // Auto-install sox if missing before attempting capture
    try {
        const { attemptSelfHeal } = await import("../agents/self-heal.js");
        // Proactively check for sox
        const { execFile: ef } = await import("node:child_process");
        const { promisify: p } = await import("node:util");
        const execCheck = p(ef);
        try { await execCheck("rec", ["--version"]); } catch {
            console.log("[OVERLAY] sox not found — attempting auto-install...");
            const heal = await attemptSelfHeal("spawn rec ENOENT");
            if (heal.fixed) {
                console.log(`[OVERLAY] sox auto-installed (${heal.action})`);
            }
        }
    } catch { /* self-heal module not available — proceed anyway */ }

    try {
        // Use macOS `rec` (from sox) to record from default mic
        // Format: 16kHz mono WAV — optimal for Whisper
        activeRecording = spawn("rec", [
            recordingPath,
            "rate", "16000",
            "channels", "1",
            "trim", "0", "30", // max 30 seconds
        ], { stdio: "ignore" });

        activeRecording.on("error", () => {
            console.warn("[OVERLAY] rec (sox) not found — trying macOS system recording...");
            // Fallback: use macOS `say` to at least not crash, or try /usr/bin/rec
            // The primary approach is sox via self-heal above.
            // If we get here, sox install failed. Use osascript as last resort.
            try {
                activeRecording = spawn("osascript", [
                    "-e", `do shell script "rec '${recordingPath}' rate 16000 channels 1 trim 0 30"`,
                ], { stdio: "ignore" });
                activeRecording.on("error", () => {
                    console.error("[OVERLAY] All recording methods failed");
                    sendToClient(ws, { type: "voice_status", status: "error", error: "sox not installed. Install with: brew install sox" });
                    activeRecording = null;
                });
            } catch {
                console.error("[OVERLAY] All recording methods failed");
                sendToClient(ws, { type: "voice_status", status: "error", error: "sox not installed. Install with: brew install sox" });
                activeRecording = null;
            }
        });

        sendToClient(ws, { type: "voice_status", status: "listening", text: getVoiceStagePhrase("listening") });
    } catch (err) {
        console.error("[OVERLAY] Voice capture failed:", err);
        sendToClient(ws, { type: "voice_status", status: "error", error: "mic not available" });
    }
}

async function stopVoiceCapture(ws: WebSocket): Promise<void> {
    if (!activeRecording || !recordingPath) {
        sendToClient(ws, { type: "voice_status", status: "error", error: "No recording active" });
        return;
    }

    // Stop recording
    try { activeRecording.kill("SIGINT"); } catch { /* ignore */ }
    activeRecording = null;
    const filePath = recordingPath;
    recordingPath = null;

    sendToClient(ws, { type: "voice_status", status: "processing", text: getVoiceStagePhrase("processing") });

    // Wait a moment for file to flush
    await new Promise(r => setTimeout(r, 300));

    if (!existsSync(filePath)) {
        sendToClient(ws, { type: "voice_status", status: "error", error: "Recording file not found" });
        return;
    }

    try {
        // Read audio file
        const { readFileSync: readSync } = await import("node:fs");
        const audioBuffer = readSync(filePath);

        // ── Primary path: Whisper transcription (accurate STT) ──
        let transcript = "";
        try {
            const { transcribeBuffer } = await import("../voice/transcribe.js");
            transcript = await transcribeBuffer(Buffer.from(audioBuffer), filePath.endsWith(".wav") ? "audio.wav" : "audio.ogg");
            console.log(`[OVERLAY] 🎤 Whisper transcription: "${transcript}"`);
        } catch (whisperErr) {
            console.warn("[OVERLAY] Whisper transcription failed:", (whisperErr as Error).message);
        }

        if (transcript && transcript.trim().length > 0) {
            // Simple voice message — user spoke words, just send as text
            sendToClient(ws, { type: "voice_result", text: transcript.trim() });
            await handleOverlayMessage(ws, transcript.trim());
        } else {
            // No speech detected — fall back to Gemini audio analysis (music, ambient sounds)
            const base64Audio = audioBuffer.toString("base64");
            const mimeType = filePath.endsWith(".wav") ? "audio/wav" : "audio/ogg";
            console.log(`[OVERLAY] 🔍 No speech detected — sending to Gemini for audio analysis...`);

            const geminiAnalysis = await analyzeAudioWithGemini(base64Audio, mimeType);
            console.log(`[OVERLAY] ✅ Gemini analysis: "${geminiAnalysis.substring(0, 100)}..."`);

            const enrichedPrompt = `[VOICE MESSAGE FROM USER]\nThe user sent a voice message with no clear speech. Audio analysis:\n\n${geminiAnalysis}\n\nIMPORTANT: Respond naturally. If music was identified, tell them the song. If it was ambient sounds, mention them casually. NEVER mention Gemini, analysis pipelines, or internal processing.`;

            sendToClient(ws, { type: "voice_result", text: "" });
            await handleOverlayMessage(ws, enrichedPrompt);
        }

        // Clean up temp file
        try { unlinkSync(filePath); } catch { /* ignore */ }
    } catch (err) {
        console.error("[OVERLAY] Voice processing failed:", err);
        sendToClient(ws, { type: "voice_status", status: "error", error: "voice processing failed" });
        try { unlinkSync(filePath); } catch { /* ignore */ }
    }
}

// ── Gemini Audio Analysis (shared with Telegram) ──

async function analyzeAudioWithGemini(
    base64Audio: string,
    mimeType: string,
): Promise<string> {
    const sessionToken = await getSessionToken();
    if (!sessionToken) throw new Error("Not authenticated");

    const proxyUrl = `${getConvexSiteUrl()}/api/llm/chat`;
    const response = await encryptedFetch(proxyUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
            model: "google/gemini-3.1-flash-lite-preview",
            messages: [
                {
                    role: "system",
                    content: `You are an expert audio analysis and music identification assistant. Analyze the audio in extreme detail.

**CRITICAL FOR MUSIC**: If music or a song is playing, you MUST:
- Transcribe ALL audible lyrics word-for-word, even partial or unclear ones (use [unclear] markers but still attempt)
- Identify the EXACT song name, artist, album, and year if possible
- If you're not 100% sure, provide your TOP 3 best guesses with confidence percentages
- Recognize the genre, subgenre, BPM feel, and musical style
- NEVER say "unidentifiable" — always give your best guess based on melody, rhythm, vocals, and lyrics
- Think about the vocal style, production style, and musical characteristics to narrow down the artist

Provide analysis in these categories:

1. **Transcription**: ALL words spoken or sung (transcribe as much as possible, even fragments)
2. **User's Intent/Command**: What the user wants (if speaking) or what they might be asking about the music
3. **Tone & Emotion**: Emotional quality of the voice/music
4. **🎵 Music/Song Identification**:
   - Best match: [Song Name] by [Artist] (confidence: X%)
   - Alternative matches if unsure
   - Genre/subgenre
   - Key lyrics that helped identification
   - Musical characteristics (tempo, instruments, vocal style)
5. **Background Sounds**: Environmental/ambient audio
6. **Language**: Language(s) detected
7. **Additional Context**: Audio quality, notable production elements

Be thorough — your analysis directly determines whether the user gets a correct song identification.`,
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "input_audio" as "text",
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            input_audio: { data: base64Audio, format: mimeType.includes("wav") ? "wav" : "ogg" },
                        } as any,
                    ],
                },
            ],
            max_tokens: 2048,
        }),
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`Audio analysis failed: ${response.status} — ${(errData as any).error || "Unknown"}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || "Could not analyze audio content.";
}

// ── Live Voice Mode (Gemini Live / OpenAI Realtime) ──

async function handleLiveVoiceStart(ws: WebSocket): Promise<void> {
    try {
        const { startLiveVoice, getActiveLiveSession, isLiveVoiceAvailable } = await import("../voice/live/integration.js");

        if (getActiveLiveSession()?.isActive) {
            sendToClient(ws, { type: "voice_live_status", status: "already_active" });
            return;
        }

        if (!isLiveVoiceAvailable()) {
            sendToClient(ws, { type: "voice_live_status", status: "unavailable", error: "No voice API keys configured" });
            return;
        }

        sendToClient(ws, { type: "voice_live_status", status: "connecting" });

        const session = await startLiveVoice(llmClient!);

        // Forward session events to overlay client
        session.on("session_started", () => {
            sendToClient(ws, { type: "voice_live_status", status: "active" });
        });

        session.on("response_transcript", (transcript: string) => {
            sendToClient(ws, { type: "voice_live_transcript", text: transcript, role: "assistant" });
        });

        session.on("interrupted", () => {
            sendToClient(ws, { type: "voice_live_status", status: "interrupted" });
        });

        session.on("tool_call", (calls: any[]) => {
            sendToClient(ws, { type: "voice_live_tool", tools: calls.map((c: any) => c.name) });
        });

        session.on("error", (err: Error) => {
            sendToClient(ws, { type: "voice_live_status", status: "error", error: err.message });
        });

        session.on("session_ended", () => {
            sendToClient(ws, { type: "voice_live_status", status: "ended" });
        });

    } catch (err) {
        console.error("[OVERLAY] Live voice start failed:", err);
        sendToClient(ws, { type: "voice_live_status", status: "error", error: (err as Error).message });
    }
}

async function handleLiveVoiceStop(ws: WebSocket): Promise<void> {
    try {
        const { stopLiveVoice } = await import("../voice/live/integration.js");
        await stopLiveVoice();
        sendToClient(ws, { type: "voice_live_status", status: "ended" });
    } catch (err) {
        console.error("[OVERLAY] Live voice stop failed:", err);
    }
}

// ── Cleanup ───────────────────────────────────

// ── Native Overlay Launcher ──────────────────
// Spawns the native Swift overlay app as the overlay window.
// The Swift app is a thin window shell — all logic stays in this server.

function launchNativeOverlay(): void {
    // Only supported on macOS
    if (process.platform !== "darwin") return;

    // Locate the binary — check release build first, then debug
    const projectRoot = join(__dirname, "..", "..");
    const releaseBin = join(projectRoot, "overlay-app", ".build", "release", "ATLASOverlay");
    const debugBin = join(projectRoot, "overlay-app", ".build", "debug", "ATLASOverlay");
    const binary = existsSync(releaseBin) ? releaseBin : existsSync(debugBin) ? debugBin : null;

    if (!binary) {
        console.log("💬 Native overlay not built — run: cd overlay-app && ./build.sh");
        return;
    }

    try {
        nativeOverlayProcess = spawn(binary, [], {
            detached: false,
            stdio: "ignore",
        });

        nativeOverlayProcess.on("error", (err) => {
            console.log(`💬 Native overlay failed to start: ${err.message}`);
            nativeOverlayProcess = null;
        });

        nativeOverlayProcess.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                console.log(`💬 Native overlay exited with code ${code}`);
            }
            nativeOverlayProcess = null;
        });

        console.log("💬 Native overlay launched");
    } catch (err) {
        console.log(`💬 Failed to launch native overlay: ${err}`);
    }
}

export function closeOverlayChat(): void {
    if (nativeOverlayProcess) { try { nativeOverlayProcess.kill(); } catch { /* */ } nativeOverlayProcess = null; }
    if (activeRecording) { try { activeRecording.kill(); } catch { /* */ } activeRecording = null; }
    if (placeholderInterval) { clearInterval(placeholderInterval); placeholderInterval = null; }
    if (wss) { wss.close(); wss = null; }
    if (httpServer) { httpServer.close(); httpServer = null; }
    overlayClients.clear();
    console.log("💬 Overlay chat server closed");
}
