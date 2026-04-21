// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Smart Tool Router v2 ──────────────────────────────────────────
// An intelligent tool selection system that goes beyond simple keyword matching.
//
// Key Features:
//   1. SEMANTIC UNDERSTANDING — Uses MiniLM embeddings for genuine intent comprehension
//   2. INTENT CLASSIFICATION — Detects primary intent (action, research, creation, etc.)
//   3. CO-OCCURRENCE LEARNING — Learns which tools are commonly used together
//   4. QUERY EXPANSION — Expands user queries with synonyms and related concepts
//   5. TASK CHAINS — Pre-loads tool sequences for common multi-step workflows
//   6. CONFIDENCE SCORING — Provides confidence levels for selections
//   7. HISTORICAL LEARNING — Tracks tool success rates to prioritize reliable tools
//   8. SMART PRELOADING — Anticipates needed tools based on conversation context
//
// Architecture:
//   1. Each tool category has a rich natural-language description
//   2. On boot, all descriptions are embedded into 384-dim vectors
//   3. User messages are analyzed for intent + expanded with related concepts
//   4. Multiple scoring signals are combined for final tool selection
//   5. A `request_tools` meta-tool lets the LLM ask for more tools mid-task
//   6. Usage patterns are tracked to improve future selections

import { createHash } from "node:crypto";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { LLMClient } from "./llm.js";
import { MODELS } from "./llm.js";
import { getMCPToolSchemas } from "./mcp/client.js";
import { getRelevantSkillSlugs } from "./skills/loader.js";
import {
    detectTaskChain,
    getCategoriesForChain,
    getFollowUpTools,
    getLikelyCategories,
    getPreferredTools,
    initAnalytics,
    recordToolUsage,
    updateCategoryAffinity,
} from "./tool-router-analytics.js";
import { getToolSchemas } from "./tools/index.js";
import { extractJSON } from "./utils/json-extract.js";

// ── Types ─────────────────────────────────────

export interface ToolRouterSelection {
    tools: ChatCompletionTool[];
    categories: string[];
    skillSlugs: string[];
    totalAvailable: number;
    selectedCount: number;
    /**
     * The LLM classifier's output for this turn, or null if the structural
     * fallback path was used. Present on every call (including cache hits)
     * so callers can implement fast-path gates without relying on
     * module-level state that's vulnerable to races / cache staleness.
     */
    classification: { intent: string; specific_tools: string[]; confidence: number; categories: string[] } | null;
}

interface CategoryDef {
    description: string; // Rich NL description for embedding
    tools: string[]; // Tool names in this category
    alwaysInclude?: boolean; // Always send these to the LLM
    embedding?: Float32Array; // Pre-computed embedding (set at boot)
}

interface ToolRequest {
    capability: string;
    reason: string;
}

// ── Tool Category Registry ────────────────────
// Each category has a rich semantic description that captures INTENT, not just keywords.
// The embedder understands meaning — "I need to navigate to a website" will match
// the browser category even without the word "browser" in the user's message.

const CATEGORIES: Record<string, CategoryDef> = {
    core: {
        description: "Basic utilities: getting the current time, date, timezone lookups. Always needed for any task.",
        tools: ["get_current_time"],
        alwaysInclude: true,
    },
    memory: {
        description:
            "Remembering information, storing facts, searching past memories, recalling what the user told me before, remembering preferences, saving notes, managing knowledge and identity information about the user. Self-editing core memory sections: reading, replacing, appending, and deleting content from identity, traits, preferences, or custom memory sections.",
        tools: [
            "memory_store",
            "memory_search",
            "memory_list",
            "memory_delete",
            "identity_view",
            "identity_update",
            "trait_update",
            "trait_list",
            "memory_snapshot",
            "core_memory_read",
            "core_memory_replace",
            "core_memory_append",
            "core_memory_delete",
        ],
        alwaysInclude: true,
    },
    shell: {
        description:
            "Running terminal commands, executing shell scripts, system administration, installing packages with npm pip brew apt, running code, compiling, building projects, git operations, checking processes, development workflow. Long-running background processes, monitoring command output.",
        tools: [
            "shell_exec",
            "shell_exec_background",
            "shell_check_process",
            "shell_wait_process",
            "shell_kill_process",
        ],
    },
    file_system: {
        description:
            "Reading files, writing files, creating files, editing documents and code, listing directories, searching files by name or content, searching code with regex, finding files by glob pattern, deleting files, file metadata, compressing archives, managing the trash can, opening files in applications, appending to log files.",
        tools: [
            "read",
            "edit",
            "write",
            "append_file",
            "grep",
            "glob",
            "list_directory",
            "delete_file",
            "file_metadata",
            "compress_files",
            "trash_manager",
            "open_in_app",
        ],
    },
    coding: {
        description:
            "Writing code, debugging code, fixing bugs, implementing new features, refactoring, code review, reading source files, making precise edits to existing code, searching the codebase for patterns or symbols, finding files by glob pattern, running build and test commands, iterating on a development task. Includes plan mode for structured research-then-implement workflows.",
        // Order matters: the top-N tools (up to MAX_TOOLS_PER_CATEGORY) are
        // the ones most likely to be included when the category fits a query.
        // Keep the highest-value coding primitives first.
        tools: [
            "read",
            "edit",
            "write",
            "grep",
            "glob",
            "notebook_edit",
            "lsp",
            "test_run",
            "fix_issue",
            "shell_exec",
            "append_file",
            "repo_map",
            "enter_plan_mode",
            "exit_plan_mode",
            "enter_spec_mode",
            "finalize_spec",
            "code_action",
            "code_execute",
            "browser_verify",
            "stock_image_search",
            "icon_search",
            "web_asset_download",
            "scaffold_project",
            "shell_exec_background",
            "shell_check_process",
            "shell_wait_process",
            "shell_kill_process",
            "list_directory",
            "delete_file",
            "get_current_time",
            // Phase 4L: codebase comprehension + git
            "codebase_index",
            "codebase_query",
            "code_change_summary",
            "agents_md_scaffold",
            "git_op",
            "generate_design_docs",
            "generate_walkthrough",
            "render_md_to_pdf",
        ],
    },
    browser: {
        description:
            "Web browsing, navigating to websites and URLs, clicking on web page elements, typing into web forms, scrolling web pages, extracting data from websites, scraping, automating web interactions, filling out online forms, logging into websites, web page analysis, tab management, uploading files to websites, downloading from the web, opening multiple URLs in parallel tabs, batch processing. Includes using the user's real Chrome browser via extension (for their active tab, logged-in sites, current page) or headless Playwright (for independent research, background tasks). When the user references 'my tab', 'this page', 'use my Chrome', or asks about what they're viewing, prefer chrome mode.",
        tools: [
            "browser_navigate",
            "browser_click_at",
            "browser_type",
            "browser_scan",
            "browser_extract",
            "browser_back",
            "browser_scroll",
            "browser_analyze",
            "browser_run_js",
            "browser_wait",
            "browser_select",
            "browser_right_click",
            "browser_hold_click",
            "browser_drag",
            "browser_hover",
            "browser_keyboard",
            "browser_switch_tab",
            "browser_close",
            "browser_upload_file",
            "browser_multi_action",
            "browser_scroll_element",
            "browser_save_strategy",
            "browser_recall_strategy",
            "browser_parallel_tabs",
            "browser_parallel_actions",
            "browser_replay_actions",
            "browser_cache_actions",
            "browser_set_mode",
            "browser_chrome_status",
            "browser_click",
        ],
    },
    web_search: {
        description:
            "Searching the internet, looking up information online, Google search, finding answers, researching topics, fact-checking, finding news, looking up definitions or documentation, checking weather and forecasts.",
        tools: ["web_search", "weather"],
    },
    os_control: {
        description:
            "Controlling the computer's operating system, taking screenshots of the desktop, clicking on screen elements by coordinates or OCR text, typing into OS applications, interacting with native desktop apps, visual verification of UI elements, screen capture, mouse control, keyboard input automation, macOS Automator, AppleScript, PowerShell automation, accessibility tree inspection, keyboard shortcuts for apps, fast accessibility-based navigation, hierarchical computer use for complex multi-step desktop automation tasks.",
        tools: [
            "os_nav",
            "os_click_element", // Primary: fast accessibility-based interaction
            "apple_script",
            "os_screenshot",
            "os_click",
            "os_type",
            "os_context",
            "os_ocr_click",
            "os_visual_verify",
            "set_brightness",
            "send_screenshot",
            "os_accessibility_tree",
            "os_keyboard_shortcuts",
            "os_scan",
            "os_multi_action",
            "os_zoom_region",
            // Windows equivalents (only one platform is loaded at a time)
            "powershell_script",
            "win_os_screenshot",
            "win_os_click",
            "win_os_type",
            "win_os_context",
            "win_os_ocr_click",
            "win_os_visual_verify",
            "win_set_brightness",
            "win_send_screenshot",
            // Hierarchical computer use agent
            "computer_use",
        ],
    },
    system_controls: {
        description:
            "System settings and hardware controls: volume, brightness, clipboard, system info, WiFi, Bluetooth, Do Not Disturb, dark mode, locking the screen, display sleep.",
        tools: [
            "set_volume",
            "clipboard",
            "system_info",
            "wifi_control",
            "bluetooth_control",
            "set_do_not_disturb",
            "dark_mode",
            "lock_screen",
            "sleep_display",
        ],
    },
    media: {
        description:
            "Full Spotify control (play/pause/skip/queue/volume/shuffle/repeat, search, playlists, library, devices) via the `spogo` CLI — which talks to Spotify's internal web-player endpoints using browser cookies, so it works for every user on Free or Premium without the closed public Web API. Local-app URI-launch fallback when spogo isn't installed. Apple Music control. Generating images and artwork, AI art, screen recording, searching for GIFs and memes, audio visualization and spectrograms, controlling Sonos speakers and smart home audio.",
        tools: [
            "spotify",
            "music_control",
            "generate_image",
            "screen_record",
            "gif_search",
            "audio_visualize",
            "sonos_control",
        ],
    },
    video_editing: {
        description:
            "Full video editing pipeline: cut, trim, join, render videos; make reels, shorts, TikToks; add captions, subtitles, transitions (fade, xfade, dissolve), music with beat-sync, sound effects; background removal; auto-crop to vertical; export to DaVinci Resolve or Premiere. Use for any task that involves editing, combining, or producing video content from one or more video files.",
        tools: [
            "video_create_project",
            "video_analyze",
            "video_plan_edit",
            "video_render",
            "video_patch_plan",
            "video_ffmpeg",
            "video_list_projects",
            "davinci_script",
            "blender_script",
        ],
    },
    presentation: {
        description:
            "Creating, modifying, and exporting slide decks, presentations, PPT, PowerPoint, pitch decks, sales decks, research presentations, QBRs, board decks, training materials, keynote slides. Producing editable .pptx files (and HTML/Reveal.js) with charts, images, action titles, bento grids, stat callouts, timelines, two-column layouts, quotes, and process steps. Modify existing decks in-session: change titles, bullets, layouts, add/remove slides, switch themes. Use when the user asks to make, create, build, generate, edit, modify, change, update, tweak, or add to a presentation, slide deck, PPT, PowerPoint, Keynote, pitch deck, or slides. Supports listing previously-created decks.",
        tools: ["create_presentation", "modify_presentation", "export_presentation", "list_presentations"],
    },
    communication: {
        description:
            "Sending emails, sending messages to the user on any channel (Telegram, WhatsApp, Discord, Slack, Matrix, overlay), sending files to the user, cross-channel messaging, notifications. Use send_message_on_channel to send messages on a specific channel, whatsapp_send for WhatsApp contacts, contact_lookup to find contacts.",
        tools: [
            "email_send",
            "messages_tool",
            "send_file",
            "send_message_on_channel",
            "whatsapp_send",
            "contact_lookup",
        ],
    },
    scheduling: {
        description:
            "Scheduling tasks for later, creating reminders, managing calendar events, setting alarms, to-do lists, recurring tasks, planning events, managing webhooks, Apple Notes for note-taking and organizing information.",
        tools: [
            "schedule_task",
            "set_reminder",
            "list_tasks",
            "cancel_task",
            "calendar_tool",
            "reminders_tool",
            "apple_notes",
            "register_webhook",
            "list_webhooks",
            "task_queue",
        ],
    },
    app_management: {
        description:
            "Managing applications, opening apps, closing apps, force-quitting apps, listing running apps, window management, moving windows, resizing windows, drag and drop operations, macOS Shortcuts.",
        tools: ["app_manager", "window_manage", "os_drag", "run_shortcut"],
    },
    research: {
        description:
            "Deep research on complex topics, long-running research tasks, multi-source investigation, synthesizing information from many sources, writing research reports, academic research.",
        tools: ["deep_research", "check_deep_research", "cancel_deep_research"],
    },
    long_tasks: {
        description:
            "Long-running coding tasks, building entire websites, generating large codebases, multi-step complex projects that take a long time to complete, swarm orchestration for parallel sub-tasks.",
        tools: ["start_long_task", "check_long_task", "cancel_long_task", "resume_long_task", "swarm_task"],
    },
    google_api: {
        description:
            "Google services: Google Calendar for managing events, Gmail for reading and sending email, Google account management.",
        tools: ["google_accounts", "google_calendar", "gmail"],
    },
    github: {
        description:
            "GitHub operations: managing repositories, creating issues, pull requests, viewing code, GitHub API interactions.",
        tools: ["github"],
    },
    code_execution: {
        description:
            "Executing JavaScript code snippets that call multiple tools programmatically. Code-as-action pattern for multi-step operations — more efficient than sequential tool calls. Running generated code in a sandbox with access to all tools. Composing tool calls with loops, conditionals, and data transformation in code.",
        tools: ["code_execute", "code_action"],
    },
    codebase: {
        description:
            "Understanding code repositories, mapping codebase structure, finding functions and classes in a project, getting an overview of a repository's architecture, listing symbols (functions, classes, interfaces, types) across files, tracing call-graphs, finding where a symbol is used, generating AGENTS.md + .atlas/agents/*.md onboarding docs, reading recent git activity (commits, hot files, diffs, blame) for context. Repository analysis, navigation, and onboarding.",
        tools: ["repo_map", "codebase_index", "codebase_query", "code_change_summary", "agents_md_scaffold"],
    },
    tool_creation: {
        description:
            "Creating new tools at runtime when you need a capability that doesn't exist yet. Dynamic tool creation, building custom tools on the fly, extending capabilities, making tools for novel tasks, sideloading external skills from ClawHub or other sources.",
        tools: ["create_tool", "list_dynamic_tools", "sideload_skill"],
        alwaysInclude: true,
    },
    document: {
        description:
            "Creating, editing, ingesting, and exporting structured documents: resumes, CVs, cover letters, reports, letters, invoices, memos. Use for 'make me a resume', 'update my resume', 'add this job to my resume', 'write a cover letter for Acme', 'export as PDF', 'export as Word', 'change the template'. Also for ingesting a user-uploaded PDF resume into editable JSON (ingest_pdf_document) before making changes — PDF text cannot be edited in-place, so ingest → edit → re-export is the required workflow. Templates are bundled (classic ATS, modern, cover letter, report) and extensible via the store.",
        tools: [
            "create_document",
            "update_document",
            "append_resume_work",
            "list_documents",
            "load_document",
            "delete_document",
            "export_document",
            "list_templates",
            "set_document_template",
            "ingest_pdf_document",
        ],
    },
};

// Skill category mapping is now server-side — categories come from skill metadata cache.

// ── Types for Caching ────────────────────────

interface CachedEmbedding {
    hash: string;
    embedding: Float32Array;
    timestamp: number;
}

interface CachedSelection {
    key: string;
    result: ToolRouterSelection;
    timestamp: number;
}

interface CategoryRequest {
    categories: string[];
    lastUsedIteration: number;
}

// ── State ─────────────────────────────────────

const categoryEmbeddings: Map<string, Float32Array> = new Map();
const mcpToolEmbeddings: Map<string, Float32Array> = new Map(); // Pre-computed MCP embeddings
let embeddingsReady = false;
let initPromise: Promise<void> | null = null;
let activeRequestedCategories: CategoryRequest = { categories: [], lastUsedIteration: 0 };
let currentIteration = 0;

// ── LLM Client for Intent Classification ─────
let routerLLM: LLMClient | null = null;

export function setToolRouterLLM(llm: LLMClient): void {
    routerLLM = llm;
    console.log("🎯 Tool Router: LLM classifier enabled");
}

// ── LLM Intent Classification ────────────────
// Uses a cheap/fast model (Haiku) to understand user intent and select tool categories.
// This replaces pattern matching with genuine language understanding.

interface IntentClassification {
    intent: string; // e.g. "music_playback", "shell_command", "info_lookup"
    categories: string[]; // e.g. ["media", "web_search"]
    specific_tools: string[]; // e.g. ["spotify"]
    confidence: number; // 0-1
}

const intentCache: Map<string, { result: IntentClassification; timestamp: number }> = new Map();
const INTENT_CACHE_TTL_MS = 120_000; // 2 minutes
const LLM_CLASSIFIER_TIMEOUT_MS = 8000; // 8s — Convex proxy adds ~2s latency to Haiku calls

async function classifyWithLLM(
    message: string,
    recentTools?: string[],
    conversationContext?: string,
): Promise<IntentClassification | null> {
    if (!routerLLM) return null;

    // Check cache — include conversation context hash for disambiguation
    const cacheKey = simpleHash(`${message}|${(conversationContext || "").substring(0, 200)}`);
    const cached = intentCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < INTENT_CACHE_TTL_MS) {
        return cached.result;
    }

    // Build compact category + tool listing for the classifier
    const categoryList = Object.entries(CATEGORIES)
        .filter(([_, def]) => !def.alwaysInclude)
        .map(
            ([name, def]) =>
                `${name}: ${def.description.substring(0, 120)} [tools: ${def.tools.slice(0, 6).join(", ")}${def.tools.length > 6 ? "..." : ""}]`,
        )
        .join("\n");

    const recentContext =
        recentTools && recentTools.length > 0 ? `\nRecently used tools: ${recentTools.slice(0, 5).join(", ")}` : "";

    // Conversation context helps disambiguate references like "open the file manager"
    // (OS Finder vs. a button on a website the user was just discussing)
    const historyContext = conversationContext
        ? `\n\nRECENT CONVERSATION (use this to understand what the user is referring to — critical for disambiguation):\n${conversationContext}`
        : "";

    const systemPrompt = `You are an ultra-fast tool router for an AI agent. Given a user message, identify which tool categories and specific tools are needed.

Available categories:
${categoryList}

Rules:
- Return 1-4 categories maximum — only what's truly needed
- Return specific tool names when obvious (e.g. "play music" → spotify)
- Focus on the user's ACTUAL intent, not surface keywords
- "play a song" = media, NOT shell (don't confuse "play" with "run/execute")
- "run npm install" = shell, NOT media
- IMPORTANT: Use the conversation context to resolve ambiguous references. If the user was just discussing a website, "open file manager" likely means a button ON that website (browser), not the OS file manager (app_management).${recentContext}${historyContext}

Respond with JSON only: {"intent":"short_label","categories":["cat1"],"specific_tools":["tool1"],"confidence":0.9}`;

    try {
        const response = await Promise.race([
            routerLLM.chat({
                messages: [{ role: "user", content: message }],
                systemPrompt,
                modelOverride: MODELS.HAIKU,
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), LLM_CLASSIFIER_TIMEOUT_MS),
            ),
        ]);

        const text = response?.choices?.[0]?.message?.content || "";
        // Extract JSON from response (handle markdown code blocks, nested braces)
        const jsonStr = extractJSON(text);
        if (!jsonStr) return null;

        const parsed = JSON.parse(jsonStr) as IntentClassification;

        // Validate categories exist
        parsed.categories = (parsed.categories || []).filter((c) => CATEGORIES[c]);
        parsed.specific_tools = parsed.specific_tools || [];
        parsed.intent = parsed.intent || "unknown";
        parsed.confidence = Math.min(1, Math.max(0, parsed.confidence || 0.5));

        // Cache the result (with TTL sweep to prevent stale buildup)
        const now = Date.now();
        intentCache.set(cacheKey, { result: parsed, timestamp: now });
        if (intentCache.size > MAX_CACHE_SIZE) {
            // Sweep expired entries first
            for (const [key, val] of intentCache) {
                if (now - val.timestamp > INTENT_CACHE_TTL_MS) intentCache.delete(key);
            }
            // If still over capacity, evict oldest by timestamp
            if (intentCache.size > MAX_CACHE_SIZE) {
                let oldestKey: string | undefined;
                let oldestTime = Infinity;
                for (const [key, val] of intentCache) {
                    if (val.timestamp < oldestTime) {
                        oldestTime = val.timestamp;
                        oldestKey = key;
                    }
                }
                if (oldestKey) intentCache.delete(oldestKey);
            }
        }

        console.log(
            `🧠 LLM Classifier: intent="${parsed.intent}" cats=[${parsed.categories}] tools=[${parsed.specific_tools}] conf=${parsed.confidence}`,
        );
        return parsed;
    } catch (err) {
        // LLM failed — caller will use fallback
        console.warn(`🧠 LLM Classifier: fallback (${(err as Error).message})`);
        return null;
    }
}

// ── Keyword Hard-Boosts (fallback enhancement) ──
// Guaranteed minimum scores for high-signal domain phrases.
// Only used when LLM classifier is unavailable.

const KEYWORD_BOOSTS: { pattern: RegExp; category: string; minScore: number }[] = [
    // Music / Media
    {
        pattern: /\b(play|pause|skip|next|previous|shuffle|repeat|queue|now.?playing)\b/i,
        category: "media",
        minScore: 0.5,
    },
    {
        pattern: /\b(song|music|track|artist|album|playlist|spotify|apple.?music|tune|beat|listen)\b/i,
        category: "media",
        minScore: 0.65,
    },
    { pattern: /\b(gif|giphy|meme|sticker)\b/i, category: "media", minScore: 0.6 },
    { pattern: /\b(sonos|speaker|airplay)\b/i, category: "media", minScore: 0.6 },
    { pattern: /\b(spectrogram|waveform|audio.?viz)\b/i, category: "media", minScore: 0.7 },
    // Weather / Search
    { pattern: /\b(weather|forecast|temperature|rain|sunny|humid)\b/i, category: "web_search", minScore: 0.7 },
    // Scheduling / Notes
    { pattern: /\b(remind|reminder|todo|to.?do)\b/i, category: "scheduling", minScore: 0.65 },
    { pattern: /\b(note|notes|apple.?notes)\b/i, category: "scheduling", minScore: 0.6 },
    { pattern: /\b(calendar|event|meeting|appointment)\b/i, category: "scheduling", minScore: 0.7 },
    // GitHub
    {
        pattern: /\b(github|pull.?request|merge|issue|repo|commit|ci.?cd|workflow.?run)\b/i,
        category: "github",
        minScore: 0.7,
    },
    // Communication
    { pattern: /\b(email|gmail|mail|imessage|sms|text.?message)\b/i, category: "communication", minScore: 0.65 },
    // OS / Screenshots
    { pattern: /\b(screenshot|screen.?shot|screen.?capture)\b/i, category: "os_control", minScore: 0.7 },
    // Browser
    { pattern: /\b(website|webpage|url|browse|navigate.?to|open.?site)\b/i, category: "browser", minScore: 0.65 },
    // Shell
    {
        pattern: /\b(terminal|npm|pip|brew|apt|git\b|docker|sudo|bash|chmod|mkdir)\b/i,
        category: "shell",
        minScore: 0.65,
    },
    // Research
    { pattern: /\b(deep.?research|investigate|comprehensive.?research)\b/i, category: "research", minScore: 0.8 },
    // Presentation / Slide decks
    {
        pattern:
            /\b(presentation|presentations|slide.?deck|slide.?decks|pitch.?deck|sales.?deck|keynote|power.?point|powerpoint|pptx?|\.pptx?|gamma)\b/i,
        category: "presentation",
        minScore: 0.8,
    },
    {
        pattern:
            /\b(make|create|build|generate|design|produce|put.?together|whip.?up)\b.{0,40}?\b(slides?|deck|presentation|pitch|ppt)\b/i,
        category: "presentation",
        minScore: 0.8,
    },
    {
        pattern: /\b(modify|edit|change|update|tweak|revise|fix)\b.{0,40}?\b(slides?|deck|presentation)\b/i,
        category: "presentation",
        minScore: 0.8,
    },
    {
        pattern: /\b(add|remove|delete|insert|reorder|swap|move)\b.{0,30}?\bslides?\b/i,
        category: "presentation",
        minScore: 0.8,
    },
    {
        pattern: /\b(export|convert|render|save)\b.{0,40}?\b(slides?|deck|presentation)\b/i,
        category: "presentation",
        minScore: 0.75,
    },
    // ── Coding — debugging, fixing, refactoring, writing code ──
    // Patterns are deliberately conjunctive: coding verbs + coding objects,
    // not bare keywords. A user saying "TypeScript tutorials" should NOT
    // trigger coding — they want to browse, not code.
    {
        pattern:
            /\b(debug|refactor|implement(ation)?|compile|stack.?trace|exception|traceback|syntax.?error|type.?error|typecheck)\b/i,
        category: "coding",
        minScore: 0.7,
    },
    {
        pattern: /\b(fix.*(bug|error|issue|crash|typo)|fix.*code|find.*bug|broken.*code)\b/i,
        category: "coding",
        minScore: 0.75,
    },
    // File-extension references are strong coding signal (a user saying ".ts" or "foo.py" is talking about a real file)
    { pattern: /\b\w+\.(ts|tsx|jsx|js|mjs|cjs|py|rs|go|cpp|hpp|java|rb|ipynb)\b/i, category: "coding", minScore: 0.75 },
    // Language name only counts as coding when paired with a coding verb or object
    {
        pattern:
            /\b(typescript|javascript|python|golang|rust|swift)\b.*\b(code|function|class|interface|module|script|file|error|bug|test|compile|implement|refactor)\b/i,
        category: "coding",
        minScore: 0.7,
    },
    {
        pattern: /\b(function|class|interface|method)\b.*\b(add|remove|rename|modify|change|update|fix|implement)\b/i,
        category: "coding",
        minScore: 0.7,
    },
    {
        pattern: /\b(goto.?definition|find.?references|workspace.?symbol|document.?symbol|hover.?info)\b/i,
        category: "coding",
        minScore: 0.85,
    },
    { pattern: /\b(notebook|jupyter|kernel)\b/i, category: "coding", minScore: 0.7 },
    { pattern: /\b(grep|ripgrep)\b.*\b(for|in|across)\b/i, category: "coding", minScore: 0.65 },
    { pattern: /\b(glob)\b.*\b(pattern|files?)\b/i, category: "coding", minScore: 0.6 },
    { pattern: /\b(find|list)\b.*\bfiles?\b.*\b(matching|pattern)\b/i, category: "coding", minScore: 0.55 },
    {
        pattern: /\b(plan.?mode|research.?first|investigate.?first|exit.?plan.?mode|enter.?plan.?mode)\b/i,
        category: "coding",
        minScore: 0.75,
    },
    {
        pattern: /\b(edit.*code|modify.*function|update.*class|change.*interface|replace.*import)\b/i,
        category: "coding",
        minScore: 0.7,
    },
    // Lint / linter is a coding tool but users may also say "lint the house" etc. — narrow to linter/eslint/biome/clippy/ruff
    {
        pattern: /\b(eslint|biome|clippy|ruff|lint(er|ing)?\s+(error|warning|fails|pass))\b/i,
        category: "coding",
        minScore: 0.7,
    },
    // Test running — frameworks or "run tests"/"failing test" phrasing (stays conjunctive to avoid "test the water")
    {
        pattern: /\b(jest|vitest|pytest|mocha|playwright|cargo\s+test|go\s+test)\b/i,
        category: "coding",
        minScore: 0.85,
    },
    {
        pattern: /\b(run|execute|invoke)\b.{0,20}?\b(tests?|test\s+suite|unit\s+tests?|integration\s+tests?|spec)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern: /\b(failing|failed|broken|red)\b.{0,20}?\b(tests?|test\s+suite|assertions?|specs?)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    { pattern: /\b(tdd|test.driven|write.*tests?\s+for|add.*tests?\s+for)\b/i, category: "coding", minScore: 0.75 },
    // Spec mode / acceptance criteria
    {
        pattern: /\b(spec|specification|acceptance\s+criteria)\b.{0,30}?\b(for|of|the)\b/i,
        category: "coding",
        minScore: 0.7,
    },
    { pattern: /\b(finalize\s+spec|enter\s+spec\s+mode|write\s+a?\s+spec)\b/i, category: "coding", minScore: 0.85 },
    // fix_issue localizer
    {
        pattern: /\b(localize|pinpoint|find\s+(?:the\s+)?cause\s+of)\b.{0,30}?\b(error|failure|crash|bug)\b/i,
        category: "coding",
        minScore: 0.75,
    },
    // UI/frontend verification via browser_verify — fires when the user mentions rendering the page, checking in a browser, or UI-centric frameworks
    {
        pattern:
            /\b(verify|check|test|preview|render)\b.{0,30}?\b(ui|frontend|page|component|form|dashboard|route|view|layout)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern: /\b(localhost|dev\s+server|vite|next\s+dev|npm\s+run\s+dev|pnpm\s+dev|yarn\s+dev)\b/i,
        category: "coding",
        minScore: 0.75,
    },
    {
        pattern: /\b(browser[_\s-]?verify|post[_\s-]?coding\s+check|visual\s+(?:regression|check))\b/i,
        category: "coding",
        minScore: 0.85,
    },
    // Web design — asset search + scaffolding
    {
        pattern: /\b(stock\s+image|stock\s+photo|hero\s+image|unsplash|pexels|picsum)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern:
            /\b(icon(?:s|ify)?|svg\s+icon|lucide|heroicons?|phosphor|tabler|font.?awesome)\b.{0,30}?\b(search|find|need|add|pick)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern: /\b(scaffold|bootstrap)\b.{0,30}?\b(project|app|website|site|starter)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern:
            /\b(vite|next\.?js|astro|tailwind|shadcn|framer.?motion|three\.?js|r3f|react.?three.?fiber|gsap|lottie)\b/i,
        category: "coding",
        minScore: 0.75,
    },
    // 3D / animation intent — route to coding so R3F/Three tools surface
    {
        pattern:
            /\b(3d|three.?d|webgl|shader|scene|mesh|geometry)\b.{0,40}?\b(website|page|component|animation|scroll|hero)\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern: /\b(landing\s+page|hero\s+section|pricing\s+page|portfolio\s+site|marketing\s+site)\b/i,
        category: "coding",
        minScore: 0.75,
    },
    // Phase 4L: codebase comprehension
    {
        pattern:
            /\b(architecture.?overview|mindmap|subsystem.?map|project.?structure|codebase.?(map|overview|structure))\b/i,
        category: "codebase",
        minScore: 0.8,
    },
    {
        pattern: /\b(find.?usages|where.*(called|used)|call.?sites?|used.?by|callers?\s+of)\b/i,
        category: "codebase",
        minScore: 0.75,
    },
    { pattern: /\b(dependency.?chain|import.?path|how.*depends.*on)\b/i, category: "codebase", minScore: 0.75 },
    {
        pattern: /\b(agents\.?md|AGENTS\.?md|atlas.?agents?|project.?memory.?doc)\b/i,
        category: "codebase",
        minScore: 0.85,
    },
    {
        pattern: /\b(hot.?files?|recent.?commits?|what.*(changed|moved).*(recent|last))\b/i,
        category: "codebase",
        minScore: 0.7,
    },
    // Phase 4L: git write-side
    {
        pattern: /\b(git.?(commit|add|push|stash|merge|rebase|reset|revert|cherry.?pick|switch|branch|tag|clean))\b/i,
        category: "coding",
        minScore: 0.8,
    },
    {
        pattern: /\b(force.?push|reset.?hard|clean.?force|amend.*(commit|message))\b/i,
        category: "coding",
        minScore: 0.85,
    },
    { pattern: /\b(stage|unstage|cherry.?pick|conflict|merge.?conflict)\b/i, category: "coding", minScore: 0.7 },
    // Design-docs / walkthrough intent — route to coding so generate_design_docs
    // and generate_walkthrough reach the selected tool set
    { pattern: /\b(prd|product\s+requirement|technical\s+design|architecture\s+doc|design\s+doc|walkthrough|rfc)\b/i, category: "coding", minScore: 0.75 },
];

// ── Caching State ─────────────────────────────

const messageEmbeddingCache: Map<string, CachedEmbedding> = new Map();
const selectionCache: Map<string, CachedSelection> = new Map();
const SELECTION_CACHE_TTL_MS = 60_000; // 60 seconds
const MAX_CACHE_SIZE = 50;
const CATEGORY_EXPIRY_ITERATIONS = 10; // Auto-expire after 10 unused iterations

// ── Collision-free hash function for cache keys ───────

function simpleHash(str: string): string {
    // Use SHA-256 for collision-free hashing (truncated to 12 chars for compactness)
    return createHash("sha256").update(str).digest("hex").substring(0, 12);
}

// ── Query Expansion ───────────────────────────
// Expands user messages with synonyms for better embedding matches

// ── Context-Aware Synonym Expansion ──────────
// Expands queries with synonyms for the embedding fallback path.
// Context-aware: "play" + music context → "stream listen", not "run execute"

interface ContextSynonym {
    context: RegExp;
    synonyms: string[];
}

const CONTEXT_SYNONYMS: Record<string, ContextSynonym[] | string[]> = {
    play: [
        {
            context: /\b(song|music|track|artist|album|playlist|spotify|tune|beat|listen)\b/i,
            synonyms: ["stream", "listen", "music playback"],
        },
        { context: /\b(video|movie|clip|youtube)\b/i, synonyms: ["watch", "stream video"] },
        { context: /.*/, synonyms: ["start", "execute"] },
    ],
    open: [
        { context: /\b(website|url|http|page|site|\.com)\b/i, synonyms: ["navigate", "browse"] },
        { context: /\b(app|application|program)\b/i, synonyms: ["launch", "activate"] },
        { context: /\b(file|document|folder)\b/i, synonyms: ["read", "access"] },
        { context: /.*/, synonyms: ["launch", "start"] },
    ],
    make: ["create", "generate"],
    "look up": ["search", "find"],
    find: ["search", "locate"],
    close: ["quit", "exit"],
    send: ["deliver", "message"],
    save: ["store", "write"],
    delete: ["remove", "trash"],
    edit: ["modify", "update"],
    show: ["display", "view"],
    get: ["fetch", "retrieve"],
};

function expandQuery(message: string): string {
    let expanded = message;

    for (const [word, value] of Object.entries(CONTEXT_SYNONYMS)) {
        const regex = new RegExp(`\\b${word}\\b`, "gi");
        if (!regex.test(message)) continue;

        if (Array.isArray(value) && typeof value[0] === "string") {
            // Simple synonyms (no context)
            expanded += ` ${(value as string[]).slice(0, 2).join(" ")}`;
        } else {
            // Context-aware: find first matching context
            for (const entry of value as ContextSynonym[]) {
                if (entry.context.test(message)) {
                    expanded += ` ${entry.synonyms.slice(0, 2).join(" ")}`;
                    break;
                }
            }
        }
    }

    return expanded;
}

// ── The request_tools meta-tool schema ────────

const REQUEST_TOOLS_SCHEMA: ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_tools",
        description:
            "Request additional tools when you realize you need capabilities not currently available. Describe what you need and the router will provide the right tools on your next turn. Use this when the task evolved and you need different tools than what was initially provided.",
        parameters: {
            type: "object",
            properties: {
                capability: {
                    type: "string",
                    description:
                        "Describe the capability you need in natural language. Examples: 'browser automation to navigate websites', 'file system tools to read and write files', 'image generation', 'email sending', 'spotify music control', 'screen control and mouse clicking', 'GitHub repository management'",
                },
                reason: {
                    type: "string",
                    description: "Brief explanation of why you need these tools now (what changed in the task)",
                },
            },
            required: ["capability", "reason"],
        },
    },
};

// ── Boot: Pre-compute Category + MCP Embeddings ─────

export async function initToolRouter(): Promise<void> {
    if (embeddingsReady) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const INIT_TIMEOUT_MS = 10_000; // 10 second timeout

        try {
            const { embedBatch, isReady } = await import("./memory/embeddings.js");

            // Wait for embedding model with timeout
            if (!isReady()) {
                const { warmup } = await import("./memory/embeddings.js");
                const warmupPromise = warmup();
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("Model warmup timeout")), INIT_TIMEOUT_MS),
                );
                await Promise.race([warmupPromise, timeoutPromise]);
            }

            // ── Embed categories ──
            const categoryNames = Object.keys(CATEGORIES);
            const descriptions = categoryNames.map((name) => CATEGORIES[name].description);

            console.log(`🎯 Tool Router: Embedding ${categoryNames.length} categories...`);
            const categoryEmbeddingResults = await embedBatch(descriptions);

            for (let i = 0; i < categoryNames.length; i++) {
                categoryEmbeddings.set(categoryNames[i], categoryEmbeddingResults[i]);
            }

            // ── Pre-embed MCP tools (big performance win) ──
            const mcpSchemas = getMCPToolSchemas();
            if (mcpSchemas.length > 0) {
                console.log(`🎯 Tool Router: Pre-embedding ${mcpSchemas.length} MCP tools...`);
                const mcpDescriptions = mcpSchemas.map((t) => t.function.description || t.function.name);
                const mcpEmbeddingResults = await embedBatch(mcpDescriptions);

                for (let i = 0; i < mcpSchemas.length; i++) {
                    mcpToolEmbeddings.set(mcpSchemas[i].function.name, mcpEmbeddingResults[i]);
                }
            }

            embeddingsReady = true;
            console.log(
                `🎯 Tool Router: ✅ Ready (${categoryNames.length} categories, ${mcpSchemas.length} MCP tools embedded)`,
            );

            // Initialize analytics for co-occurrence learning
            initAnalytics();
        } catch (err) {
            console.error("🎯 Tool Router: ❌ Failed to init embeddings:", (err as Error).message);
            console.log("🎯 Tool Router: Falling back to structural analysis mode");
            initPromise = null;
        }
    })();

    return initPromise;
}

// ── Get cached message embedding ─────────────

async function getCachedMessageEmbedding(message: string): Promise<Float32Array> {
    const hash = simpleHash(message);
    const cached = messageEmbeddingCache.get(hash);

    if (cached && cached.hash === hash) {
        return cached.embedding;
    }

    const { embedText } = await import("./memory/embeddings.js");
    const embedding = await embedText(message);

    // Evict oldest if cache is full
    if (messageEmbeddingCache.size >= MAX_CACHE_SIZE) {
        const oldest = [...messageEmbeddingCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
        if (oldest) messageEmbeddingCache.delete(oldest[0]);
    }

    messageEmbeddingCache.set(hash, { hash, embedding, timestamp: Date.now() });
    return embedding;
}

// ── Check selection cache ─────────────────────

function getSelectionCacheKey(message: string, recentToolCalls?: string[], contextHash?: string): string {
    const toolPart = recentToolCalls ? recentToolCalls.sort().join(",") : "";
    return simpleHash(`${message}|${toolPart}|${contextHash || ""}`);
}

function getCachedSelection(key: string): ToolRouterSelection | null {
    const cached = selectionCache.get(key);
    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.timestamp > SELECTION_CACHE_TTL_MS) {
        selectionCache.delete(key);
        return null;
    }

    return cached.result;
}

function cacheSelection(key: string, result: ToolRouterSelection): void {
    // Evict oldest if cache is full
    if (selectionCache.size >= MAX_CACHE_SIZE) {
        const oldest = [...selectionCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
        if (oldest) selectionCache.delete(oldest[0]);
    }

    selectionCache.set(key, { key, result, timestamp: Date.now() });
}

// ── Core Classification Engine ────────────────
// Uses semantic embeddings when available, falls back to structural analysis

async function classifyToolNeeds(
    message: string,
    recentToolCalls?: string[],
    _iteration?: number,
): Promise<{ category: string; score: number; confidence: number }[]> {
    // ── HYBRID: Always run structural first (instant, catches keywords) ──
    const structural = structuralClassify(message);
    const scoreMap = new Map<string, number>(structural.map((s) => [s.category, s.score]));

    // ── Overlay semantic scores if embeddings ready (raises scores, never lowers) ──
    if (embeddingsReady) {
        try {
            const { cosineSimilarity } = await import("./memory/embeddings.js");
            const messageEmbedding = await getCachedMessageEmbedding(message);

            for (const [name, embedding] of categoryEmbeddings.entries()) {
                const similarity = cosineSimilarity(messageEmbedding, embedding);
                const current = scoreMap.get(name) || 0;
                scoreMap.set(name, Math.max(current, similarity));
            }
        } catch {
            // Embedding failed — structural scores stand alone
        }
    }

    const scores = Array.from(scoreMap.entries()).map(([category, score]) => ({
        category,
        score,
        confidence: score,
    }));

    // ── Boost categories in active use ──
    if (recentToolCalls && recentToolCalls.length > 0) {
        const recentCategories = getUsedCategories(recentToolCalls);
        for (const sc of scores) {
            if (recentCategories.has(sc.category)) {
                sc.score = Math.max(sc.score, 0.5);
            }
        }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores;
}

// ── Structural fallback classifier ────────────
// Used when embeddings aren't ready yet (e.g., during boot before model loads)

function structuralClassify(message: string): { category: string; score: number }[] {
    const msg = message.toLowerCase();
    const scores: { category: string; score: number }[] = [];

    const patterns: Record<string, RegExp[]> = {
        browser: [
            /\b(brows|website|url|http|www\.|\.com|\.org|page|web ?page|navigate|login|sign.?in|form|click|scrape|download)\b/i,
            /\b(tab|bookmark|cookie|html|css|javascript|dom|xpath)\b/i,
        ],
        web_search: [
            /\b(search|google|look ?up|find ?(out|info|about)|research|what is|who is|how to|define|explain)\b/i,
        ],
        os_control: [
            /\b(screenshot|screen ?shot|screen ?capture|click|mouse|keyboard|type|desktop|app|window|ocr|screen)\b/i,
            /\b(apple ?script|automator|shortcut|finder|dock)\b/i,
        ],
        shell: [
            /\b(terminal|command|shell|bash|zsh|npm|pip|brew|apt|git|compile|build|run|execute|install|deploy|docker|process)\b/i,
            /\b(mkdir|rm|ls|cd|cat|grep|chmod|curl|wget|ssh|scp|sudo)\b/i,
        ],
        file_system: [
            /\b(file|folder|directory|read|write|create|edit|save|delete|path|document|text|csv|json|pdf|copy|move|rename)\b/i,
        ],
        coding: [
            /\b(debug|refactor|implement|compile|stack.?trace|exception|traceback|syntax.?error|typecheck)\b/i,
            /\bfix.*(bug|error|issue|crash|typo)\b/i,
            // File-extension references are a strong coding signal on their own
            /\b\w+\.(ts|tsx|jsx|js|mjs|cjs|py|rs|go|cpp|hpp|java|rb|ipynb)\b/i,
            /\b(source ?code|codebase|source files?|src\/|lib\/|test\/)\b/i,
            /\b(unit.?test|integration.?test|jest|vitest|pytest|mocha|cargo.?test)\b/i,
            /\b(goto.?definition|find.?references|workspace.?symbol|document.?symbol)\b/i,
            /\b(notebook|jupyter|ipynb)\b/i,
            /\b(plan.?mode|exit.?plan.?mode|enter.?plan.?mode)\b/i,
            /\b(eslint|biome|clippy|ruff|rust-?analyzer|typescript-language-server|pyright)\b/i,
        ],
        media: [
            /\b(spotify|music|song|track|tracks|artist|artists|album|albums|playlist|playlists|play|pause|skip|shuffle|repeat|queue|now.?playing|image|picture|photo|generate|art|draw|paint|blender|3d|video|record|lyrics|discover.?weekly|release.?radar|sonos|speaker|airplay)\b/i,
        ],
        communication: [
            /\b(email|mail|send|message|imessage|sms|text|notify|telegram|whatsapp|contact|person|saying|said|asking|asked|talking)\b/i,
        ],
        scheduling: [
            /\b(schedule|remind|alarm|calendar|event|meeting|appointment|timer|cron|recurring|todo|task.?list|later|tomorrow|next week)\b/i,
        ],
        system_controls: [
            /\b(volume|brightness|wifi|bluetooth|dark ?mode|do not disturb|dnd|clipboard|lock|sleep|system ?info)\b/i,
        ],
        app_management: [
            /\b(open ?app|close ?app|force ?quit|window|resize|minimize|maximize|full ?screen|split|arrange)\b/i,
        ],
        research: [/\b(deep ?research|investigate|analyze|comprehensive|thorough|report|study|synthesis)\b/i],
        long_tasks: [
            /\b(build.*(website|app|project|codebase)|long.?running|complex.?task|entire|full|complete.*build|swarm)\b/i,
        ],
        google_api: [/\b(google|gmail|gcal|google ?calendar|google ?account)\b/i],
        github: [/\b(github|repo|repository|pull ?request|pr|issue|commit|branch|merge)\b/i],
        document: [
            /\b(resume|resumé|curriculum vitae|cv|cover letter|cover.?letter)\b/i,
            /\b(job application|apply(ing)? (for|to) (a |an )?job|applying somewhere)\b/i,
            /\b(export|render|save|need|want|turn.+into|make.+into).*\b(pdf|docx|word)\b/i,
            /\b(make|create|draft|write|generate|produce|compose)\b.*\b(pdf|docx|word document|word doc|letter|memo|report|invoice)\b/i,
            /\b(ingest|parse|extract|edit).*\b(pdf|resume)\b/i,
        ],
    };

    for (const [category, regexes] of Object.entries(patterns)) {
        let matched = 0;
        for (const re of regexes) {
            if (re.test(msg)) matched++;
        }
        // Normalize: if any pattern matches, give a moderate score
        const score = matched > 0 ? 0.3 + matched * 0.15 : 0.05;
        scores.push({ category, score });
    }

    // Always add core and memory with high scores
    scores.push({ category: "core", score: 0.9 });
    scores.push({ category: "memory", score: 0.4 });

    return scores;
}

// ── Determine which categories were recently used ──

function getUsedCategories(toolNames: string[]): Set<string> {
    const used = new Set<string>();
    for (const toolName of toolNames) {
        for (const [catName, catDef] of Object.entries(CATEGORIES)) {
            if (catDef.tools.includes(toolName)) {
                used.add(catName);
            }
        }
    }
    return used;
}

// ── Fast-Path Selection (no embeddings) ───────
// For simple greetings/acks classified as "llm_only" — skip the entire
// embedding pipeline and return ZERO tools. This prevents the LLM from
// unnecessarily checking the time or memory just to say "hello", ensuring
// a single-iteration instant response.
export function selectToolsFast(): ToolRouterSelection {
    console.log(`🎯 Tool Router: 0 tools selected [fast-path: simple chat]`);
    return {
        tools: [],
        categories: ["chat_only"],
        skillSlugs: [],
        totalAvailable: getToolSchemas().length,
        selectedCount: 0,
        classification: null,
    };
}

// ── Main Selection API ────────────────────────

// ── Last classified intent + full classification (exported for fast-path gates) ──
let lastClassifiedIntent = "";
let lastClassification: {
    intent: string;
    specific_tools: string[];
    confidence: number;
    categories: string[];
} | null = null;

export function getLastIntent(): string {
    return lastClassifiedIntent;
}

/**
 * Returns the most recent LLM-classifier result, or null if the LLM classifier
 * didn't run (e.g. structural fallback was used). Agent-level fast paths must
 * treat a null return as "not confident — use the normal flow".
 */
export function getLastClassification(): {
    intent: string;
    specific_tools: string[];
    confidence: number;
    categories: string[];
} | null {
    return lastClassification;
}

// Tool selection caps. These must be large enough to hold the ~17 tools
// from alwaysInclude categories (memory=13, core=1, tool_creation=3) PLUS
// a meaningful contribution from whatever categories the query triggered —
// especially `coding`, which has 21 candidate tools that need real room.
const MAX_TOOLS_TOTAL = 36;
const MAX_TOOLS_PER_CATEGORY = 12;

export async function selectTools(opts: {
    message: string;
    recentToolCalls?: string[];
    iteration?: number;
    requestedCategories?: string[];
    conversationContext?: string;
}): Promise<ToolRouterSelection> {
    const startTime = Date.now();
    currentIteration++;

    // ── Check selection cache first ──
    // Include conversation context hash so different conversation states get different tool selections
    const ctxHash = opts.conversationContext ? simpleHash(opts.conversationContext.substring(0, 200)) : "";
    const cacheKey = getSelectionCacheKey(opts.message, opts.recentToolCalls, ctxHash);
    const cachedResult = getCachedSelection(cacheKey);
    if (cachedResult && !opts.requestedCategories) {
        console.log(`🎯 Tool Router: Cache HIT (${Date.now() - startTime}ms)`);
        return cachedResult;
    }

    const allSchemas = getToolSchemas();
    const allToolNames = new Set(allSchemas.map((t) => t.function.name));

    // Apply any explicitly requested categories
    if (opts.requestedCategories) {
        activeRequestedCategories = {
            categories: opts.requestedCategories,
            lastUsedIteration: currentIteration,
        };
    }

    // ══════════════════════════════════════════════
    // STAGE 1: INTENT CLASSIFICATION
    // Primary: LLM classifier (understands meaning)
    // Fallback: Structural + Semantic hybrid
    // ══════════════════════════════════════════════

    let selectedCategories: string[] = [];
    let specificTools: string[] = [];
    let classifierUsed = "fallback";

    // Try LLM classifier first (primary path)
    const llmResult = await classifyWithLLM(opts.message, opts.recentToolCalls, opts.conversationContext);

    if (llmResult && llmResult.categories.length > 0 && llmResult.confidence >= 0.4) {
        selectedCategories = [...llmResult.categories];
        specificTools = llmResult.specific_tools || [];
        lastClassifiedIntent = llmResult.intent;
        lastClassification = {
            intent: llmResult.intent,
            specific_tools: [...(llmResult.specific_tools || [])],
            confidence: llmResult.confidence,
            categories: [...llmResult.categories],
        };
        classifierUsed = "llm";
    } else {
        lastClassification = null;
        // Fallback: hybrid structural + semantic + keyword boosts
        const expandedMessage = expandQuery(opts.message);
        const ranked = await classifyToolNeeds(expandedMessage, opts.recentToolCalls, opts.iteration);

        // Apply keyword hard-boosts to ranked scores
        for (const { pattern, category, minScore } of KEYWORD_BOOSTS) {
            if (pattern.test(opts.message)) {
                const entry = ranked.find((r) => r.category === category);
                if (entry) {
                    entry.score = Math.max(entry.score, minScore);
                    entry.confidence = Math.max(entry.confidence, minScore);
                } else {
                    ranked.push({ category, score: minScore, confidence: minScore });
                }
            }
        }
        ranked.sort((a, b) => b.score - a.score);

        // Dynamic threshold
        const topScore = ranked.length > 0 ? ranked[0].score : 0;
        const topConfidence = ranked.length > 0 ? ranked[0].confidence : 0;
        let threshold = embeddingsReady ? Math.max(0.15, topScore * 0.45) : 0.25;
        if (topConfidence < 0.3) {
            threshold = Math.max(0.1, threshold * 0.7);
        }

        // Select categories above threshold
        for (const { category, score } of ranked) {
            const catDef = CATEGORIES[category];
            if (!catDef) continue;
            if (score >= threshold || catDef.alwaysInclude) {
                selectedCategories.push(category);
            }
        }

        // Infer intent from top category
        lastClassifiedIntent = selectedCategories[0] || "general";
        classifierUsed = embeddingsReady ? "hybrid" : "structural";

        if (ranked.length > 0) {
            const topN = ranked
                .slice(0, 5)
                .map((r) => `${r.category}:${r.score.toFixed(2)}`)
                .join("  ");
            console.log(`   📊 Fallback scores: ${topN} (threshold: ${threshold.toFixed(2)})`);
        }
    }

    // ── Task chain preloading ──
    const detectedChain = detectTaskChain(opts.message);
    if (detectedChain) {
        const chainCats = getCategoriesForChain(detectedChain);
        for (const cat of chainCats) {
            if (!selectedCategories.includes(cat)) {
                selectedCategories.push(cat);
            }
        }
    }

    // ── Co-occurrence learning ──
    const likelyCategories = getLikelyCategories(selectedCategories);
    for (const likeCat of likelyCategories) {
        if (!selectedCategories.includes(likeCat)) {
            selectedCategories.push(likeCat);
        }
    }

    // ── Boost from explicitly requested categories ──
    if (activeRequestedCategories.categories.length > 0) {
        const iterationsUnused = currentIteration - activeRequestedCategories.lastUsedIteration;
        if (iterationsUnused > CATEGORY_EXPIRY_ITERATIONS) {
            activeRequestedCategories = { categories: [], lastUsedIteration: 0 };
        } else {
            for (const cat of activeRequestedCategories.categories) {
                if (!selectedCategories.includes(cat)) {
                    selectedCategories.push(cat);
                }
            }
        }
    }

    // ── Always include alwaysInclude categories ──
    for (const [catName, catDef] of Object.entries(CATEGORIES)) {
        if (catDef.alwaysInclude && !selectedCategories.includes(catName)) {
            selectedCategories.push(catName);
        }
    }

    // ══════════════════════════════════════════════
    // STAGE 2: USER PREFERENCE RANKING
    // Rank tools within selected categories by user behavior
    // ══════════════════════════════════════════════

    // Gather all candidate tools from selected categories
    let candidateTools: string[] = [];
    for (const catName of selectedCategories) {
        const catDef = CATEGORIES[catName];
        if (!catDef) continue;
        for (const toolName of catDef.tools) {
            if (allToolNames.has(toolName) && !candidateTools.includes(toolName)) {
                candidateTools.push(toolName);
            }
        }
    }

    // Prioritize specific tools from LLM classifier
    if (specificTools.length > 0) {
        const specific = new Set(specificTools.filter((t) => allToolNames.has(t)));
        candidateTools = [
            ...candidateTools.filter((t) => specific.has(t)),
            ...candidateTools.filter((t) => !specific.has(t)),
        ];
    }

    // Apply user preference ranking (personalization)
    candidateTools = getPreferredTools(lastClassifiedIntent, candidateTools);

    // Add follow-up tools from learned user patterns
    const followUps = getFollowUpTools(candidateTools.slice(0, 5));
    for (const fu of followUps) {
        if (allToolNames.has(fu) && !candidateTools.includes(fu)) {
            candidateTools.push(fu);
        }
    }

    // Update category affinity
    updateCategoryAffinity(selectedCategories);

    // ══════════════════════════════════════════════
    // STAGE 3: TOOL ASSEMBLY — Cap at MAX_TOOLS
    // Precision filter: only send what's needed
    // ══════════════════════════════════════════════

    const selectedToolNames = new Set<string>();

    // Always include tools from alwaysInclude categories (core, memory, tool_creation)
    for (const catName of selectedCategories) {
        const catDef = CATEGORIES[catName];
        if (catDef?.alwaysInclude) {
            for (const t of catDef.tools) {
                if (allToolNames.has(t)) selectedToolNames.add(t);
            }
        }
    }

    // Reserve a slot for the primary (first-listed) tool of each selected
    // non-alwaysInclude category. This guarantees that domain-specific tools
    // (spotify for media, shell_exec for shell, browser_navigate for browser)
    // always surface when the user's intent matches their category, even when
    // alwaysInclude categories consume most of the budget or preference
    // reordering deprioritizes a brand-new tool.
    for (const catName of selectedCategories) {
        const catDef = CATEGORIES[catName];
        if (!catDef || catDef.alwaysInclude) continue;
        const primary = catDef.tools.find((t) => allToolNames.has(t) && !selectedToolNames.has(t));
        if (primary) selectedToolNames.add(primary);
    }

    // Add candidates up to the cap, respecting per-category limits
    const catToolCounts = new Map<string, number>();
    for (const tool of candidateTools) {
        if (selectedToolNames.size >= MAX_TOOLS_TOTAL) break;
        if (selectedToolNames.has(tool)) continue;

        // Find which category this tool belongs to
        let toolCat = "";
        for (const [catName, catDef] of Object.entries(CATEGORIES)) {
            if (catDef.tools.includes(tool)) {
                toolCat = catName;
                break;
            }
        }
        const catCount = catToolCounts.get(toolCat) || 0;
        if (catCount >= MAX_TOOLS_PER_CATEGORY) continue;

        selectedToolNames.add(tool);
        catToolCounts.set(toolCat, catCount + 1);
    }

    // Build schema array
    const selectedSchemas: ChatCompletionTool[] = [];
    for (const schema of allSchemas) {
        if (selectedToolNames.has(schema.function.name)) {
            selectedSchemas.push(schema);
        }
    }

    // ── Include relevant MCP tools ──
    const mcpSchemas = getMCPToolSchemas();
    if (mcpSchemas.length > 0) {
        if (embeddingsReady && selectedSchemas.length < MAX_TOOLS_TOTAL) {
            try {
                const { cosineSimilarity } = await import("./memory/embeddings.js");
                const messageEmb = await getCachedMessageEmbedding(opts.message);
                const mcpScored: { schema: ChatCompletionTool; score: number }[] = [];

                for (const mcpTool of mcpSchemas) {
                    const toolName = mcpTool.function.name;
                    let mcpEmb = mcpToolEmbeddings.get(toolName);
                    if (!mcpEmb) {
                        const { embedText } = await import("./memory/embeddings.js");
                        mcpEmb = await embedText(mcpTool.function.description || toolName);
                        mcpToolEmbeddings.set(toolName, mcpEmb);
                    }
                    mcpScored.push({ schema: mcpTool, score: cosineSimilarity(messageEmb, mcpEmb) });
                }

                // Add top MCP tools that fit within the cap
                mcpScored.sort((a, b) => b.score - a.score);
                for (const { schema, score } of mcpScored) {
                    if (selectedSchemas.length >= MAX_TOOLS_TOTAL) break;
                    if (score >= 0.25) selectedSchemas.push(schema);
                }
            } catch {
                // If embedding fails, include top 5 MCP tools
                for (const mcpTool of mcpSchemas.slice(0, 5)) {
                    if (selectedSchemas.length < MAX_TOOLS_TOTAL) {
                        selectedSchemas.push(mcpTool);
                    }
                }
            }
        } else if (!embeddingsReady) {
            for (const mcpTool of mcpSchemas.slice(0, 5)) {
                if (selectedSchemas.length < MAX_TOOLS_TOTAL) {
                    selectedSchemas.push(mcpTool);
                }
            }
        }
    }

    // ── Always add request_tools meta-tool ──
    selectedSchemas.push(REQUEST_TOOLS_SCHEMA);

    // ── Select relevant skill slugs ──
    const skillSlugs = getRelevantSkillSlugs(selectedCategories);

    // Thread the classifier's output through the selection so callers can
    // implement fast-path gates without relying on the mutable module-level
    // `lastClassification` state — which is vulnerable to concurrent-call
    // races and stale reads on cache hits.
    const classificationForReturn: ToolRouterSelection["classification"] =
        llmResult && llmResult.categories.length > 0 && llmResult.confidence >= 0.4
            ? {
                  intent: llmResult.intent,
                  specific_tools: [...(llmResult.specific_tools || [])],
                  confidence: llmResult.confidence,
                  categories: [...llmResult.categories],
              }
            : null;

    const result: ToolRouterSelection = {
        tools: selectedSchemas,
        categories: selectedCategories,
        skillSlugs,
        totalAvailable: allSchemas.length + mcpSchemas.length,
        selectedCount: selectedSchemas.length,
        classification: classificationForReturn,
    };

    // ── Cache ──
    cacheSelection(cacheKey, result);

    // ── Logging ──
    const elapsed = Date.now() - startTime;
    const catLog = selectedCategories.join(", ");
    console.log(
        `🎯 Tool Router: ${selectedSchemas.length}/${allSchemas.length + mcpSchemas.length} tools selected [${catLog}] (${elapsed}ms, classifier: ${classifierUsed})`,
    );
    if (specificTools.length > 0) {
        console.log(`   🎯 Specific: [${specificTools.join(", ")}] | Intent: ${lastClassifiedIntent}`);
    }

    return result;
}

// ── Handle request_tools meta-tool ────────────
// Called when the LLM invokes request_tools to get additional capabilities

export async function handleToolRequest(request: ToolRequest): Promise<{
    categories: string[];
    response: string;
}> {
    const { capability, reason } = request;
    console.log(`🎯 Tool Router: LLM requested tools for "${capability}" — ${reason}`);

    // ── Find matching categories using semantic similarity ──
    const matchedCategories: string[] = [];

    if (embeddingsReady) {
        const { embedText, cosineSimilarity } = await import("./memory/embeddings.js");
        const capEmb = await embedText(capability);

        const scored: { category: string; score: number }[] = [];
        for (const [name, embedding] of categoryEmbeddings.entries()) {
            scored.push({ category: name, score: cosineSimilarity(capEmb, embedding) });
        }
        scored.sort((a, b) => b.score - a.score);

        // Take categories with score > 0.2 (reasonable match)
        for (const { category, score } of scored) {
            if (score > 0.2) {
                matchedCategories.push(category);
            }
        }
    } else {
        // Fallback: use structural matching on the capability description
        const fallback = structuralClassify(capability);
        for (const { category, score } of fallback) {
            if (score > 0.25) {
                matchedCategories.push(category);
            }
        }
    }

    if (matchedCategories.length === 0) {
        // No dedicated tool — guide toward auto-creation
        const fallbackCategories = ["tool_creation", "shell", "browser"];
        activeRequestedCategories = {
            categories: [...new Set([...activeRequestedCategories.categories, ...fallbackCategories])],
            lastUsedIteration: currentIteration,
        };
        return {
            categories: fallbackCategories,
            response:
                `No built-in tool for "${capability}". You have three options:\n` +
                `1. **create_tool** — Build a custom tool for "${capability}" using shell commands or API calls. It will persist and be reusable.\n` +
                `2. **browser tools** — If it's a web service, navigate to its URL and automate via browser.\n` +
                `3. **shell_exec** — Run CLI commands or install a tool (e.g., via npm/pip/brew) to accomplish this.\n\n` +
                `Recommended: Use create_tool if this is something you'll need again.`,
        };
    }

    // ── Store these as active categories so selectTools picks them up ──
    activeRequestedCategories = {
        categories: [...new Set([...activeRequestedCategories.categories, ...matchedCategories])],
        lastUsedIteration: currentIteration,
    };

    // ── Build detailed response with tool descriptions ──
    const toolDescriptions: string[] = [];
    for (const catName of matchedCategories) {
        const cat = CATEGORIES[catName];
        if (!cat) continue;

        toolDescriptions.push(`\n### ${catName.toUpperCase()}`);
        toolDescriptions.push(`${cat.description}\n`);
        toolDescriptions.push(`Available tools: ${cat.tools.join(", ")}`);
    }

    const response = `✅ Added ${matchedCategories.length} tool categories for "${capability}":\n${toolDescriptions.join("\n")}\n\nThese tools are now available in your next response. Use them as needed.`;

    console.log(
        `🎯 Tool Router: Added categories [${matchedCategories.join(", ")}] (${matchedCategories.reduce((sum, cat) => sum + (CATEGORIES[cat]?.tools.length || 0), 0)} tools)`,
    );

    return { categories: matchedCategories, response };
}

// Skill selection is now handled by getRelevantSkillSlugs() in skills/loader.ts
// Skill instructions are injected server-side by the LLM proxy.

// ── Clear requested categories (call on conversation reset) ──

export function clearToolRouterState(): void {
    activeRequestedCategories = { categories: [], lastUsedIteration: 0 };
    messageEmbeddingCache.clear();
    selectionCache.clear();
    currentIteration = 0;
    lastClassification = null;
    lastClassifiedIntent = "";
    console.log(`🎯 Tool Router: State cleared`);
}

// ── Check if a tool name is the request_tools meta-tool ──

export function isRequestToolsCall(toolName: string): boolean {
    return toolName === "request_tools";
}

// ── Record tool usage for analytics ──────────

export function recordToolUsageForAnalytics(opts: {
    toolsUsed: string[];
    categories: string[];
    success?: boolean;
}): void {
    recordToolUsage(opts);
}

// ── Get router stats ─────────────────────────

export function getRouterStats(): {
    cacheSize: number;
    embeddingCacheSize: number;
    mcpToolsEmbedded: number;
    currentIteration: number;
    embeddingsReady: boolean;
} {
    return {
        cacheSize: selectionCache.size,
        embeddingCacheSize: messageEmbeddingCache.size,
        mcpToolsEmbedded: mcpToolEmbeddings.size,
        currentIteration,
        embeddingsReady,
    };
}
