// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Module Entry Point ───────────────────
// Re-exports all browser tools and utilities

// Export types
export type {
    PlaywrightModule,
    BrowserContext,
    Page,
    ElementHandle,
    InteractiveElement,
    ElementCache,
    FrameScanResult,
    PageScanResult,
    BrowserConfig,
    ChromeTabInfo,
    ChromeBridgeCommand,
    ChromeBridgeResponse,
    ChromeBridgeEvent,
    TabInfo,
    ClickOptions,
    BrowserMode
} from "./types.js";

// Export core utilities
export {
    getBrowser,
    getActivePage,
    getInteractiveElements,
    getAccessibilityTree,
    scanPage,
    waitForPageReady,
    withRetry,
    setLastElementMap,
    getLastElementMap,
    buildElementsText,
    setActivePageIndex,
    getActivePageIndex,
    invalidateCache,
    CLICK_INDICATOR_JS,
    SCAN_FRAME_JS
} from "./core.js";

// Export navigation tools
export {
    browserNavigate,
    browserScan,
    browserBack,
    browserSwitchTab,
    browserClose
} from "./navigation.js";

// Export interaction tools
export {
    browserClickAt,
    browserClick,
    browserRightClick,
    browserHoldClick,
    browserDrag,
    browserScroll,
    browserType,
    browserHover,
    browserKeyboard,
    browserScrollElement
} from "./interaction.js";

// Export extraction tools
export {
    browserAnalyze,
    browserRunJs,
    browserWait,
    browserSelect,
    browserExtract,
    browserUploadFile,
    browserSaveStrategy,
    browserRecallStrategy,
    browserReplayActions,
    browserCacheActions
} from "./extraction.js";

// Export video control tool
export { browserVideoControl } from "./video-control.js";

// Export CAPTCHA handler
export { browserHandleCaptcha, detectCaptcha, handleCaptchaIfPresent } from "./captcha.js";

// Export popup guard utilities
export { dismissCookieBanner, dismissOverlayModals, attachPopupGuard } from "./popup-guard.js";

// Export native browser acceleration + IP protection wrapper
export {
    scoreElementCandidates,
    getVideoPlayerState, setVideoPlayerState, invalidateVideoState,
    checkBrowserRateLimit, recordBrowserAction, detectActionLoop, resetActionLoop,
    getHoverHint, recordHoverSuccess, recordHoverFailure,
    validateJsCode, obfuscateInjectedVariable, rewriteInternalVars,
    signBrowserAction, verifyBrowserAction, getActionAuditTail,
    getModuleFingerprint, isNativeBrowserAvailable,
} from "./native-browser.js";

// Export advanced tools
export {
    browserParallelTabs,
    browserParallelActions,
    browserMultiAction
} from "./advanced.js";

// Export Chrome bridge
export {
    initChromeBridge,
    isExtensionConnected,
    getExtensionTabs,
    getActiveExtensionTab,
    sendBridgeCommand,
    closeChromeBridge,
    onExtensionEvent,
    getBridgeStats,
    getBridgeToken,
    rotateBridgeToken
} from "./chrome-bridge.js";

// Export backend manager
export {
    getActiveBackend,
    setPreferredMode,
    resolveBackend,
    getCurrentMode,
    switchToPlaywright,
    switchToChromeExtension,
    resetBackend,
    registerPlaywrightBackend,
    registerChromeBackend
} from "./browser-backend.js";
export type { BrowserBackend, BrowserPageInfo } from "./browser-backend.js";

// Export Chrome backend
export { ChromeExtensionBackend, ChromePageProxy } from "./chrome-backend.js";

// Export Playwright passthrough backend
export { PlaywrightPassthroughBackend } from "./playwright-backend.js";

// Export action cache
export {
    initActionCache,
    getCachedActions,
    shouldReplayActions,
    cacheActions,
    markActionFailed,
    replayActions,
    getActionCacheStats
} from "./action-cache.js";
export type { CachedAction, CachedActionStep } from "./action-cache.js";

// Export mode tools
export { browserSetMode, browserChromeStatus } from "./mode-tools.js";

// ── Browser Cleanup Function ────────────────────

import { getBrowser, invalidateCache } from "./core.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browserContextRef: any = null;

export async function closeBrowser(): Promise<void> {
    try {
        const context = await getBrowser();
        browserContextRef = context;
        await context.close();
        browserContextRef = null;
    } catch {
        // Browser might already be closed
    }
    // Clear cache on browser close
    invalidateCache();
}

// ── Default Export: All Tool Definitions ────────

import { browserNavigate, browserScan, browserBack, browserSwitchTab, browserClose as browserCloseTool } from "./navigation.js";
import { browserClickAt, browserClick, browserRightClick, browserHoldClick, browserDrag, browserScroll, browserType, browserHover, browserKeyboard, browserScrollElement } from "./interaction.js";
import { browserAnalyze, browserRunJs, browserWait, browserSelect, browserExtract, browserUploadFile, browserSaveStrategy, browserRecallStrategy, browserReplayActions, browserCacheActions } from "./extraction.js";
import { browserParallelTabs, browserParallelActions, browserMultiAction } from "./advanced.js";
import { browserSetMode, browserChromeStatus } from "./mode-tools.js";
import { browserVideoControl } from "./video-control.js";
import { browserHandleCaptcha } from "./captcha.js";

export const browserTools = [
    // Navigation
    browserNavigate,
    browserScan,
    browserBack,
    browserSwitchTab,
    browserCloseTool,
    // Interaction
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
    // Video control (YouTube, Vimeo, HTML5 video)
    browserVideoControl,
    // CAPTCHA solving
    browserHandleCaptcha,
    // Extraction
    browserAnalyze,
    browserRunJs,
    browserWait,
    browserSelect,
    browserExtract,
    browserUploadFile,
    browserSaveStrategy,
    browserRecallStrategy,
    browserReplayActions,
    browserCacheActions,
    // Advanced
    browserParallelTabs,
    browserParallelActions,
    browserMultiAction,
    // Chrome Extension Mode
    browserSetMode,
    browserChromeStatus,
];
