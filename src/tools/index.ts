// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getCurrentTime, type ToolDefinition } from "./get-current-time.js";
import { isCacheable, getCached, setCache, checkRateLimit, auditLog, recordToolUsage, requiresConfirmation } from "./tool-intelligence.js";
import { validateToolInput } from "./schema-validator.js";
import { memoryStore, memorySearch, memoryList, memoryDelete, identityView, identityUpdate, traitUpdate, traitList, memorySnapshot } from "./memory-tools.js";
import { coreMemoryRead, coreMemoryReplace, coreMemoryAppend, coreMemoryDelete } from "./memory-tools-advanced.js";
import { shellExec } from "./shell.js";
import { listDirectory, deleteFile } from "./files.js";
import { read } from "./coding/read.js";
import { edit } from "./coding/edit.js";
import { write } from "./coding/write.js";
import { appendFile } from "./coding/append-file.js";
import { grep } from "./coding/grep.js";
import { glob } from "./coding/glob.js";
import { enterPlanModeTool, exitPlanModeTool } from "./coding/plan-mode-tools.js";
import { notebookEdit } from "./coding/notebook-edit.js";
import { lsp } from "./coding/lsp.js";
import { testRun } from "./coding/test-run.js";
import { fixIssue } from "./coding/fix-issue.js";
import { enterSpecModeTool, finalizeSpecTool } from "./coding/spec-mode-tools.js";
import { browserVerify } from "./coding/browser-verify.js";
import { appleScript, osScreenshot, osClick, osType, osContext, osOcrClick, osVisualVerify, setBrightness, sendScreenshot, osAccessibilityTree, osKeyboardShortcuts, osScan, osClickElement, osMultiAction, osZoomRegion, osNav } from "./macos.js";
import { powerShellScript, winOsScreenshot, winOsClick, winOsType, winOsContext, winOsOcrClick, winOsVisualVerify, winSetBrightness, winSendScreenshot } from "./windows.js";
import { linuxShellScript, linuxOsScreenshot, linuxOsClick, linuxOsType, linuxOsContext, linuxSetBrightness, linuxSendScreenshot } from "./linux.js";
import { IS_MAC, IS_WIN, IS_LINUX } from "./platform.js";
import { blenderScript } from "./blender.js";
import { davinciScript } from "./video.js";
import {
    videoCreateProject,
    videoAnalyze,
    videoPlanEdit,
    videoRender,
    videoPatchPlan,
    videoFfmpeg,
    videoListProjects,
} from "./video-studio.js";
import { webSearch } from "./web-search.js";
import {
    browserNavigate,
    browserScan,
    browserBack,
    browserSwitchTab,
    browserClose,
    browserClickAt,
    browserClick,
    browserRightClick,
    browserHoldClick,
    browserDrag,
    browserScroll,
    browserType,
    browserHover,
    browserKeyboard,
    browserScrollElement,
    browserAnalyze,
    browserRunJs,
    browserWait,
    browserSelect,
    browserExtract,
    browserUploadFile,
    browserSaveStrategy,
    browserRecallStrategy,
    browserParallelTabs,
    browserParallelActions,
    browserMultiAction,
    browserSetMode,
    browserChromeStatus,
    browserReplayActions,
    browserCacheActions,
} from "./browser/index.js";
import { sendFileTool } from "./send-file.js";
import { generateImage } from "./generate-image.js";
import { createPresentation, listPresentations, modifyPresentation, exportPresentation, setPresentationLLM } from "./presentation/index.js";
import { scheduleTask, listTasks, cancelTask, setReminder } from "./scheduled.js";
import { registerWebhook, listWebhooks } from "./webhook.js";
import { swarmTask, setSwarmLLM, setSwarmProgress, clearSwarmProgress } from "./swarm-tool.js";
import { deepResearch, checkDeepResearch, cancelDeepResearch, setDeepResearchLLM, setDeepResearchProgress, clearDeepResearchProgress, setDeepResearchNotifier, setOverlayResearchProgress, clearOverlayResearchProgress } from "./deep-research.js";
import { startLongTaskTool, checkLongTaskTool, cancelLongTaskTool, resumeLongTaskTool, setLongTaskLLM, setLongTaskProgress, clearLongTaskProgress } from "./long-task-tool.js";
import { shellExecBackground, shellCheckProcess, shellWaitProcess, shellKillProcess } from "./shell-monitor.js";
import { setVolume, clipboard, systemInfo, wifiControl, bluetoothControl, setDoNotDisturb, darkMode, lockScreen, sleepDisplay } from "./system-controls.js";
import { musicControl, calendarTool, remindersTool, messagesTool, windowManage, osDrag, appManager } from "./app-integrations.js";
import { spotifyTool } from "./spotify.js";
import { appleNotesTool } from "./apple-notes.js";
import { weatherTool } from "./weather.js";
import { locationTool } from "./location-tool.js";
import { gifSearch } from "./gif-search.js";
import { sonosControl } from "./sonos.js";
import { audioVisualize } from "./audio-visualize.js";
import { sideloadSkillTool } from "../store/sideload.js";
import { screenRecord, fileMetadata, compressFiles, trashManager, runShortcut, openInApp } from "./file-utils.js";
import { googleAccounts, googleCalendarTool, gmailTool } from "./google-api.js";
import { githubTool } from "./github-api.js";
import { taskQueueTool } from "./task-queue.js";
import { emailSend } from "./email-tool.js";
import { createTool, listDynamicTools, setRegistryRef, loadDynamicTools } from "./create-tool.js";
import { codeActionTool, codeExecuteTool, setCodeActionLLM, setCodeActionExecutor } from "./code-action-tool.js";
import { repoMapTool } from "./repo-map.js";
import { computerUseTool, setComputerUseLLM } from "./computer-use-tool.js";
import { whatsappSendTool, contactLookupTool, whatsappStickerTool, whatsappGroupInfoTool } from "../whatsapp.js";
import { channelSendTool, registerChannelSender, getActiveChannelSenders } from "./channel-send.js";
import { documentTools, initDocumentTools } from "./document.js";
import { setIngestLLM } from "../documents/ingest.js";
import { getMCPToolSchemas, executeMCPTool, isMCPTool } from "../mcp/client.js";
import { firePreToolUse, firePostToolUse } from "../hooks/index.js";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ── Store Tools Constants ────────────────────────
const STORE_TOOLS_PATH = path.join(homedir(), ".atlas", "store", "tools");

// Re-export injection helpers for boot wiring
export { setSwarmLLM, setSwarmProgress, clearSwarmProgress };
export { setPresentationLLM } from "./presentation/index.js";
export { loadDynamicTools } from "./create-tool.js";
export { setDeepResearchLLM, setDeepResearchProgress, clearDeepResearchProgress, setDeepResearchNotifier, setOverlayResearchProgress, clearOverlayResearchProgress };
export { setLongTaskLLM, setLongTaskProgress, clearLongTaskProgress };
export { setCodeActionLLM, setCodeActionExecutor };
export { setComputerUseLLM };
export { initSpotify } from "./spotify.js";
export { registerChannelSender, getActiveChannelSenders } from "./channel-send.js";
export { clearCache, resetRateLimits, rotateAuditLog, getToolAnalytics } from "./tool-intelligence.js";
export { initDocumentTools } from "./document.js";
export { setIngestLLM } from "../documents/ingest.js";

// ── Tool Registry ─────────────────────────────

const registry: Map<string, ToolDefinition> = new Map();

// Wire dynamic tool creator to registry
setRegistryRef(registry);

// Core tools
registry.set(getCurrentTime.schema.function.name, getCurrentTime);

// Memory tools
registry.set(memoryStore.schema.function.name, memoryStore);
registry.set(memorySearch.schema.function.name, memorySearch);
registry.set(memoryList.schema.function.name, memoryList);
registry.set(memoryDelete.schema.function.name, memoryDelete);

// Identity & trait tools
registry.set(identityView.schema.function.name, identityView);
registry.set(identityUpdate.schema.function.name, identityUpdate);
registry.set(traitUpdate.schema.function.name, traitUpdate);
registry.set(traitList.schema.function.name, traitList);
registry.set(memorySnapshot.schema.function.name, memorySnapshot);

// Core memory self-editing tools (Letta-style read/replace/append/delete)
registry.set(coreMemoryRead.schema.function.name, coreMemoryRead);
registry.set(coreMemoryReplace.schema.function.name, coreMemoryReplace);
registry.set(coreMemoryAppend.schema.function.name, coreMemoryAppend);
registry.set(coreMemoryDelete.schema.function.name, coreMemoryDelete);

// Shell tool (cross-platform)
registry.set(shellExec.schema.function.name, shellExec);

// ── Platform-specific OS tools ────────────────
if (IS_MAC) {
    // macOS: AppleScript/JXA/CoreGraphics tools
    registry.set(appleScript.schema.function.name, appleScript);
    registry.set(osScreenshot.schema.function.name, osScreenshot);
    registry.set(osClick.schema.function.name, osClick);
    registry.set(osType.schema.function.name, osType);
    registry.set(osContext.schema.function.name, osContext);
    registry.set(osOcrClick.schema.function.name, osOcrClick);
    registry.set(osVisualVerify.schema.function.name, osVisualVerify);
    registry.set(setBrightness.schema.function.name, setBrightness);
    registry.set(sendScreenshot.schema.function.name, sendScreenshot);
    registry.set(osAccessibilityTree.schema.function.name, osAccessibilityTree);
    registry.set(osKeyboardShortcuts.schema.function.name, osKeyboardShortcuts);
    registry.set(osScan.schema.function.name, osScan);
    registry.set(osClickElement.schema.function.name, osClickElement);
    registry.set(osMultiAction.schema.function.name, osMultiAction);
    registry.set(osZoomRegion.schema.function.name, osZoomRegion);
    registry.set(osNav.schema.function.name, osNav);
} else if (IS_WIN) {
    // Windows: PowerShell/user32.dll/Windows.Media.Ocr tools
    registry.set(powerShellScript.schema.function.name, powerShellScript);
    registry.set(winOsScreenshot.schema.function.name, winOsScreenshot);
    registry.set(winOsClick.schema.function.name, winOsClick);
    registry.set(winOsType.schema.function.name, winOsType);
    registry.set(winOsContext.schema.function.name, winOsContext);
    registry.set(winOsOcrClick.schema.function.name, winOsOcrClick);
    registry.set(winOsVisualVerify.schema.function.name, winOsVisualVerify);
    registry.set(winSetBrightness.schema.function.name, winSetBrightness);
    registry.set(winSendScreenshot.schema.function.name, winSendScreenshot);
} else if (IS_LINUX) {
    // Linux: xdotool/xclip/scrot/xdg-open tools
    registry.set(linuxShellScript.schema.function.name, linuxShellScript);
    registry.set(linuxOsScreenshot.schema.function.name, linuxOsScreenshot);
    registry.set(linuxOsClick.schema.function.name, linuxOsClick);
    registry.set(linuxOsType.schema.function.name, linuxOsType);
    registry.set(linuxOsContext.schema.function.name, linuxOsContext);
    registry.set(linuxSetBrightness.schema.function.name, linuxSetBrightness);
    registry.set(linuxSendScreenshot.schema.function.name, linuxSendScreenshot);
}

// System control tools (cross-platform, each handler checks platform internally)
registry.set(setVolume.schema.function.name, setVolume);
registry.set(clipboard.schema.function.name, clipboard);
registry.set(systemInfo.schema.function.name, systemInfo);
registry.set(wifiControl.schema.function.name, wifiControl);
registry.set(bluetoothControl.schema.function.name, bluetoothControl);
registry.set(setDoNotDisturb.schema.function.name, setDoNotDisturb);
registry.set(darkMode.schema.function.name, darkMode);
registry.set(lockScreen.schema.function.name, lockScreen);
registry.set(sleepDisplay.schema.function.name, sleepDisplay);

// App integration tools (cross-platform where possible)
registry.set(spotifyTool.schema.function.name, spotifyTool);
registry.set(windowManage.schema.function.name, windowManage);
registry.set(osDrag.schema.function.name, osDrag);
registry.set(appManager.schema.function.name, appManager);

// macOS-only app integrations (no Windows equivalent)
if (IS_MAC) {
    registry.set(musicControl.schema.function.name, musicControl);
    registry.set(calendarTool.schema.function.name, calendarTool);
    registry.set(remindersTool.schema.function.name, remindersTool);
    registry.set(messagesTool.schema.function.name, messagesTool);
    registry.set(runShortcut.schema.function.name, runShortcut);
    registry.set(appleNotesTool.schema.function.name, appleNotesTool);
}

// Cross-platform new tools
registry.set(weatherTool.schema.function.name, weatherTool);
registry.set(locationTool.schema.function.name, locationTool);
registry.set(gifSearch.schema.function.name, gifSearch);
registry.set(sonosControl.schema.function.name, sonosControl);
registry.set(audioVisualize.schema.function.name, audioVisualize);
registry.set(sideloadSkillTool.schema.function.name, sideloadSkillTool);

// File & utility tools
registry.set(screenRecord.schema.function.name, screenRecord);
registry.set(fileMetadata.schema.function.name, fileMetadata);
registry.set(compressFiles.schema.function.name, compressFiles);
registry.set(trashManager.schema.function.name, trashManager);
registry.set(openInApp.schema.function.name, openInApp);

// Google API tools
registry.set(googleAccounts.schema.function.name, googleAccounts);
registry.set(googleCalendarTool.schema.function.name, googleCalendarTool);
registry.set(gmailTool.schema.function.name, gmailTool);

// GitHub tools
registry.set(githubTool.schema.function.name, githubTool);

// Email tools
registry.set(emailSend.schema.function.name, emailSend);

// Task queue
registry.set(taskQueueTool.schema.function.name, taskQueueTool);

// 3D tools
registry.set(blenderScript.schema.function.name, blenderScript);

// Video tools
registry.set(davinciScript.schema.function.name, davinciScript);

// Video Studio tools
registry.set(videoCreateProject.schema.function.name, videoCreateProject);
registry.set(videoAnalyze.schema.function.name, videoAnalyze);
registry.set(videoPlanEdit.schema.function.name, videoPlanEdit);
registry.set(videoRender.schema.function.name, videoRender);
registry.set(videoPatchPlan.schema.function.name, videoPatchPlan);
registry.set(videoFfmpeg.schema.function.name, videoFfmpeg);
registry.set(videoListProjects.schema.function.name, videoListProjects);

// File tools (coding primitives + directory listing + deletion)
registry.set(read.schema.function.name, read);
registry.set(edit.schema.function.name, edit);
registry.set(write.schema.function.name, write);
registry.set(appendFile.schema.function.name, appendFile);
registry.set(grep.schema.function.name, grep);
registry.set(glob.schema.function.name, glob);
registry.set(listDirectory.schema.function.name, listDirectory);
registry.set(deleteFile.schema.function.name, deleteFile);

// Plan mode tools
registry.set(enterPlanModeTool.schema.function.name, enterPlanModeTool);
registry.set(exitPlanModeTool.schema.function.name, exitPlanModeTool);

// Jupyter notebook editor
registry.set(notebookEdit.schema.function.name, notebookEdit);

// LSP (code intelligence: goToDefinition, findReferences, hover, etc.)
registry.set(lsp.schema.function.name, lsp);
registry.set(testRun.schema.function.name, testRun);
registry.set(fixIssue.schema.function.name, fixIssue);
registry.set(enterSpecModeTool.schema.function.name, enterSpecModeTool);
registry.set(finalizeSpecTool.schema.function.name, finalizeSpecTool);
registry.set(browserVerify.schema.function.name, browserVerify);

// Web & browser tools
registry.set(webSearch.schema.function.name, webSearch);
registry.set(browserNavigate.schema.function.name, browserNavigate);
registry.set(browserScan.schema.function.name, browserScan);
registry.set(browserClickAt.schema.function.name, browserClickAt);
registry.set(browserClick.schema.function.name, browserClick);
registry.set(browserRightClick.schema.function.name, browserRightClick);
registry.set(browserHoldClick.schema.function.name, browserHoldClick);
registry.set(browserDrag.schema.function.name, browserDrag);
registry.set(browserType.schema.function.name, browserType);
registry.set(browserScroll.schema.function.name, browserScroll);
registry.set(browserExtract.schema.function.name, browserExtract);
registry.set(browserBack.schema.function.name, browserBack);
registry.set(browserAnalyze.schema.function.name, browserAnalyze);
registry.set(browserRunJs.schema.function.name, browserRunJs);
registry.set(browserWait.schema.function.name, browserWait);
registry.set(browserSelect.schema.function.name, browserSelect);
registry.set(browserSaveStrategy.schema.function.name, browserSaveStrategy);
registry.set(browserRecallStrategy.schema.function.name, browserRecallStrategy);
registry.set(browserHover.schema.function.name, browserHover);
registry.set(browserKeyboard.schema.function.name, browserKeyboard);
registry.set(browserSwitchTab.schema.function.name, browserSwitchTab);
registry.set(browserClose.schema.function.name, browserClose);
registry.set(browserUploadFile.schema.function.name, browserUploadFile);
registry.set(browserMultiAction.schema.function.name, browserMultiAction);
registry.set(browserScrollElement.schema.function.name, browserScrollElement);
registry.set(browserParallelTabs.schema.function.name, browserParallelTabs);
registry.set(browserReplayActions.schema.function.name, browserReplayActions);
registry.set(browserCacheActions.schema.function.name, browserCacheActions);
registry.set(browserParallelActions.schema.function.name, browserParallelActions);
registry.set(browserSetMode.schema.function.name, browserSetMode);
registry.set(browserChromeStatus.schema.function.name, browserChromeStatus);

// File sending
registry.set(sendFileTool.schema.function.name, sendFileTool);

// Image generation
registry.set(generateImage.schema.function.name, generateImage);

// Presentation generation
registry.set(createPresentation.schema.function.name, createPresentation);
registry.set(listPresentations.schema.function.name, listPresentations);
registry.set(modifyPresentation.schema.function.name, modifyPresentation);
registry.set(exportPresentation.schema.function.name, exportPresentation);

// Scheduled tasks
registry.set(scheduleTask.schema.function.name, scheduleTask);
registry.set(setReminder.schema.function.name, setReminder);
registry.set(listTasks.schema.function.name, listTasks);
registry.set(cancelTask.schema.function.name, cancelTask);

// Webhooks
registry.set(registerWebhook.schema.function.name, registerWebhook);
registry.set(listWebhooks.schema.function.name, listWebhooks);

// Swarm orchestration
registry.set(swarmTask.schema.function.name, swarmTask);

// Deep research (background)
registry.set(deepResearch.schema.function.name, deepResearch);
registry.set(checkDeepResearch.schema.function.name, checkDeepResearch);
registry.set(cancelDeepResearch.schema.function.name, cancelDeepResearch);

// Long-running tasks
registry.set(startLongTaskTool.schema.function.name, startLongTaskTool);
registry.set(checkLongTaskTool.schema.function.name, checkLongTaskTool);
registry.set(cancelLongTaskTool.schema.function.name, cancelLongTaskTool);
registry.set(resumeLongTaskTool.schema.function.name, resumeLongTaskTool);

// Dynamic tool creation
registry.set(createTool.schema.function.name, createTool);
registry.set(listDynamicTools.schema.function.name, listDynamicTools);

// Background shell processes
registry.set(shellExecBackground.schema.function.name, shellExecBackground);
registry.set(shellCheckProcess.schema.function.name, shellCheckProcess);
registry.set(shellWaitProcess.schema.function.name, shellWaitProcess);
registry.set(shellKillProcess.schema.function.name, shellKillProcess);

// Code-as-action agent (alternative to JSON tool calls)
registry.set(codeActionTool.schema.function.name, codeActionTool);

// Code execute (run JS code snippets with tools.* access)
registry.set(codeExecuteTool.schema.function.name, codeExecuteTool);

// Repo map (regex-based codebase symbol extraction)
registry.set(repoMapTool.schema.function.name, repoMapTool);

// Computer use agent (desktop automation)
registry.set(computerUseTool.schema.function.name, computerUseTool);

// WhatsApp messaging tools
registry.set(whatsappSendTool.schema.function.name, whatsappSendTool);
registry.set(contactLookupTool.schema.function.name, contactLookupTool);
registry.set(whatsappStickerTool.schema.function.name, whatsappStickerTool);
registry.set(whatsappGroupInfoTool.schema.function.name, whatsappGroupInfoTool);

// Cross-channel messaging tool (send messages to user on any active channel)
registry.set(channelSendTool.schema.function.name, channelSendTool);

// Document tools (create, edit, ingest, export resumes / cover letters / reports)
for (const tool of documentTools) {
    registry.set(tool.schema.function.name, tool);
}

// Warm the template registry so list_templates is instant.
try { initDocumentTools(); } catch (err) { console.warn(`[documents] init failed: ${(err as Error).message}`); }

// ── Exports ───────────────────────────────────

/** All tool schemas (built-in + MCP) */
export function getToolSchemas(): ChatCompletionTool[] {
    const builtIn = Array.from(registry.values()).map((t) => t.schema);
    const mcp = getMCPToolSchemas();
    return [...builtIn, ...mcp];
}

/** Filtered tool schemas — only the named tools */
export function getToolSchemasByNames(names: string[]): ChatCompletionTool[] {
    const nameSet = new Set(names);
    return Array.from(registry.values())
        .filter(t => nameSet.has(t.schema.function.name))
        .map(t => t.schema);
}

// ── Tool Timeout Configuration ───────────────────────
// Per-tool timeouts (in ms) - longer for I/O heavy operations
const TOOL_TIMEOUTS: Record<string, number> = {
    // Browser tools - can be slow due to page loads
    browser_navigate: 30_000,
    browser_click: 15_000,
    browser_type: 10_000,
    browser_scroll: 10_000,
    browser_scan: 20_000,
    browser_screenshot: 15_000,
    // Shell/system tools - variable execution time
    shell: 60_000,           // Shell commands can take a while
    run_code: 30_000,
    // Research/network tools
    web_search: 20_000,
    deep_research: 300_000,  // 5 minutes for deep research
    // File operations (coding primitives)
    read: 10_000,
    edit: 10_000,
    write: 10_000,
    append_file: 10_000,
    grep: 30_000,
    glob: 15_000,
    // Default for unlisted tools
    default: 30_000,
};

/** Get timeout for a specific tool */
function getToolTimeout(name: string): number {
    return TOOL_TIMEOUTS[name] ?? TOOL_TIMEOUTS.default;
}

/** Execute with timeout wrapper */
async function executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string
): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId!);
        return result;
    } catch (err) {
        clearTimeout(timeoutId!);
        throw err;
    }
}

/** Execute a tool by name — with caching, rate limiting, audit logging, timeouts, and analytics */
export async function executeTool(
    name: string,
    input: Record<string, unknown>
): Promise<string> {
    const startTime = Date.now();
    const timeout = getToolTimeout(name);

    // Check MCP tools first (bypass intelligence layer)
    if (isMCPTool(name)) {
        try {
            const result = await executeWithTimeout(executeMCPTool(name, input), timeout, name);
            auditLog({ tool: name, args: input, success: true, cached: false, durationMs: Date.now() - startTime });
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            auditLog({ tool: name, args: input, success: false, cached: false, durationMs: Date.now() - startTime, error: message });
            return JSON.stringify({ error: message });
        }
    }

    const tool = registry.get(name);
    if (!tool) {
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    // Rate limit check
    const rateCheck = checkRateLimit(name);
    if (!rateCheck.allowed) {
        auditLog({ tool: name, args: input, success: false, cached: false, durationMs: 0, error: "rate_limited" });
        return JSON.stringify({ error: rateCheck.reason });
    }

    // Zod schema validation — validate input before execution
    const validation = validateToolInput(name, input);
    if (!validation.valid) {
        const errorMessage = `Invalid input for tool "${name}": ${validation.errors?.join("; ")}`;
        console.warn(`  ⚠️ Tool input validation failed: ${errorMessage}`);
        auditLog({ tool: name, args: input, success: false, cached: false, durationMs: 0, error: "validation_failed" });
        return JSON.stringify({ error: errorMessage, validation_errors: validation.errors });
    }

    // Destructive action check — returns warning in result for LLM to handle
    const confirmCheck = requiresConfirmation(name, input);
    if (confirmCheck.needsConfirmation) {
        // Inject warning into the result so the LLM sees it and can ask the user
        // The LLM should relay this warning before proceeding
        console.log(`  ⚠️  Destructive action detected: ${name}`);
    }

    // Cache check
    if (isCacheable(name, input)) {
        const cached = getCached(name, input);
        if (cached) {
            console.log(`  ⚡ Cache hit: ${name}`);
            auditLog({ tool: name, args: input, success: true, cached: true, durationMs: 0 });
            recordToolUsage(name, true, 0);
            return cached;
        }
    }

    // PreToolUse hooks — can modify input or block the call outright.
    // Fail-open: any exception leaves input unchanged.
    let effectiveInput = input;
    try {
        const pre = await firePreToolUse(name, input);
        if (pre.block) {
            const reason = pre.block_reason ?? "Blocked by PreToolUse hook.";
            auditLog({ tool: name, args: input, success: false, cached: false, durationMs: Date.now() - startTime, error: `blocked_by_hook: ${reason}` });
            return JSON.stringify({ error: reason, blocked_by_hook: true });
        }
        if (pre.modifiedInput) {
            effectiveInput = pre.modifiedInput;
        }
    } catch (err) {
        console.warn(`[TOOL] PreToolUse hook chain errored for ${name}: ${(err as Error).message}`);
    }

    try {
        // Execute with timeout protection
        const result = await executeWithTimeout(tool.handler(effectiveInput), timeout, name);
        const durationMs = Date.now() - startTime;

        // Cache the result if eligible
        if (isCacheable(name, effectiveInput)) {
            setCache(name, effectiveInput, result);
        }

        // Determine success
        let success = true;
        try { const p = JSON.parse(result); if (p.error) success = false; } catch { /* not json */ }

        auditLog({ tool: name, args: effectiveInput, success, cached: false, durationMs });
        recordToolUsage(name, success, durationMs);

        // PostToolUse hooks — side effects only. Fire-and-forget; don't await
        // anything that could delay the agent's next iteration.
        try {
            void firePostToolUse(name, effectiveInput, result, success);
        } catch (err) {
            console.warn(`[TOOL] PostToolUse hook chain errored for ${name}: ${(err as Error).message}`);
        }

        return result;
    } catch (err) {
        const durationMs = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);
        auditLog({ tool: name, args: effectiveInput, success: false, cached: false, durationMs, error: message });
        recordToolUsage(name, false, durationMs);

        try { void firePostToolUse(name, effectiveInput, JSON.stringify({ error: message }), false); } catch { /* */ }

        return JSON.stringify({ error: `Tool "${name}" failed: ${message}` });
    }
}

/** List registered tool names */
export function getToolNames(): string[] {
    return Array.from(registry.keys());
}

/** Check if a tool name exists in the registry */
export function isKnownTool(name: string): boolean {
    return registry.has(name);
}

/** Get all registered tool names */
export function getAllToolNames(): string[] {
    return Array.from(registry.keys());
}

// ── Store Tools Support ──────────────────────────

/**
 * Check if a tool is from the store
 */
export function isStoreTool(name: string): boolean {
    return name.startsWith("store_");
}

/**
 * Load all store-installed tools at boot
 */
export async function loadStoreTools(): Promise<void> {
    if (!fs.existsSync(STORE_TOOLS_PATH)) return;

    const entries = fs.readdirSync(STORE_TOOLS_PATH, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            try {
                await registerStoreTool(path.join(STORE_TOOLS_PATH, entry.name));
            } catch (err) {
                console.error(`❌ Failed to load store tool "${entry.name}":`, (err as Error).message);
            }
        }
    }

    const storeToolCount = Array.from(registry.keys()).filter(k => k.startsWith("store_")).length;
    if (storeToolCount > 0) {
        console.log(`🔧 ${storeToolCount} store tool(s) loaded`);
    }
}

/**
 * Register a single store tool (for hot-reload)
 */
export async function registerStoreTool(toolPath: string): Promise<void> {
    const configPath = path.join(toolPath, "atlas.config.json");
    const handlerPath = path.join(toolPath, "dist", "handler.js");
    const handlerTsPath = path.join(toolPath, "handler.ts");  // For dev tools without build step

    // Validate structure
    if (!fs.existsSync(configPath)) {
        throw new Error(`Missing atlas.config.json in ${toolPath}`);
    }

    // Check for handler - either compiled or source
    let actualHandlerPath = handlerPath;
    if (!fs.existsSync(handlerPath)) {
        if (fs.existsSync(handlerTsPath)) {
            actualHandlerPath = handlerTsPath;
        } else {
            throw new Error(`Missing handler in ${toolPath}`);
        }
    }

    // Load config
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const slug = config.slug || path.basename(toolPath);

    // Dynamically import the handler
    // Clear module cache to allow hot-reload
    const resolvedPath = path.resolve(actualHandlerPath);
    const moduleUrl = `file://${resolvedPath}?t=${Date.now()}`;  // Cache bust

    try {
        const module = await import(moduleUrl);
        const tool: ToolDefinition = module.default || module.tool || module[Object.keys(module)[0]];

        if (!tool || !tool.schema || !tool.handler) {
            throw new Error(`Invalid tool export in ${toolPath}`);
        }

        // Prefix tool name to avoid conflicts with built-in tools
        const originalName = tool.schema.function.name;
        const prefixedName = `store_${slug}_${originalName}`;

        // Create new schema with prefixed name
        const storeSchema: ChatCompletionTool = {
            type: "function",
            function: {
                name: prefixedName,
                description: `[Store: ${config.name || slug}] ${tool.schema.function.description}`,
                parameters: tool.schema.function.parameters,
            },
        };

        // Create wrapper tool definition
        const storeTool: ToolDefinition = {
            schema: storeSchema,
            handler: tool.handler,
        };

        registry.set(prefixedName, storeTool);
        console.log(`🔧 Store tool registered: ${prefixedName}`);
    } catch (err) {
        throw new Error(`Failed to import handler from ${toolPath}: ${(err as Error).message}`);
    }
}

/**
 * Unregister a store tool (for hot-unload)
 */
export function unregisterStoreTool(slug: string): void {
    const prefix = `store_${slug}_`;
    const toDelete: string[] = [];

    for (const name of registry.keys()) {
        if (name.startsWith(prefix)) {
            toDelete.push(name);
        }
    }

    for (const name of toDelete) {
        registry.delete(name);
        console.log(`🔧 Store tool unregistered: ${name}`);
    }
}

/**
 * Get all store tool names
 */
export function getStoreToolNames(): string[] {
    return Array.from(registry.keys()).filter(k => k.startsWith("store_"));
}
