// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Module Entry Point ───────────────────
// Re-exports all browser tools and utilities

export type { CachedAction, CachedActionStep } from "./action-cache.js";
// Export action cache
export {
    cacheActions,
    getActionCacheStats,
    getCachedActions,
    initActionCache,
    markActionFailed,
    replayActions,
    shouldReplayActions,
} from "./action-cache.js";
// Export advanced tools
export {
    browserMultiAction,
    browserParallelActions,
    browserParallelTabs,
} from "./advanced.js";
export type { BrowserBackend, BrowserPageInfo } from "./browser-backend.js";
// Export backend manager
export {
    getActiveBackend,
    getCurrentMode,
    registerChromeBackend,
    registerPlaywrightBackend,
    resetBackend,
    resolveBackend,
    setPreferredMode,
    switchToChromeExtension,
    switchToPlaywright,
} from "./browser-backend.js";
// Export CAPTCHA handler
export { browserHandleCaptcha, detectCaptcha, handleCaptchaIfPresent } from "./captcha.js";
// Export Chrome backend
export { ChromeExtensionBackend, ChromePageProxy } from "./chrome-backend.js";
// Export Chrome bridge
export {
    closeChromeBridge,
    getActiveExtensionTab,
    getBridgeStats,
    getBridgeToken,
    getExtensionStatus,
    getExtensionTabs,
    initChromeBridge,
    isExtensionConnected,
    onExtensionEvent,
    rotateBridgeToken,
    sendBridgeCommand,
    waitForExtensionConnection,
} from "./chrome-bridge.js";
// Export core utilities
export {
    ATLAS_HUD_JS,
    AUTO_SCROLL_JS,
    buildElementsText,
    CLICK_INDICATOR_JS,
    GET_FORM_STATE_JS,
    getAccessibilityTree,
    getActivePage,
    getActivePageIndex,
    getBrowser,
    getInteractiveElements,
    getLastElementMap,
    invalidateCache,
    NETWORK_REQUESTS_JS,
    SCAN_FRAME_JS,
    SCROLL_INDICATOR_JS,
    SCROLL_TO_ELEMENT_JS,
    scanPage,
    setActivePageIndex,
    setLastElementMap,
    waitForPageReady,
    withRetry,
} from "./core.js";
// Export extraction tools
export {
    browserAnalyze,
    browserCacheActions,
    browserExtract,
    browserRecallStrategy,
    browserReplayActions,
    browserRunJs,
    browserSaveStrategy,
    browserSelect,
    browserUploadFile,
    browserWait,
} from "./extraction.js";
// Export interaction tools
export {
    browserClick,
    browserClickAt,
    browserDrag,
    browserHoldClick,
    browserHover,
    browserKeyboard,
    browserRightClick,
    browserScroll,
    browserScrollElement,
    browserType,
} from "./interaction.js";
// Export mode tools
export { browserChromeStatus, browserSetMode } from "./mode-tools.js";
// Export native browser acceleration + IP protection wrapper
export {
    checkBrowserRateLimit,
    detectActionLoop,
    getActionAuditTail,
    getHoverHint,
    getModuleFingerprint,
    getVideoPlayerState,
    invalidateVideoState,
    isNativeBrowserAvailable,
    obfuscateInjectedVariable,
    recordBrowserAction,
    recordHoverFailure,
    recordHoverSuccess,
    resetActionLoop,
    rewriteInternalVars,
    scoreElementCandidates,
    setVideoPlayerState,
    signBrowserAction,
    validateJsCode,
    verifyBrowserAction,
} from "./native-browser.js";
// Export navigation tools
export {
    browserBack,
    browserClose,
    browserNavigate,
    browserScan,
    browserSwitchTab,
} from "./navigation.js";
// Export OpenCLI-inspired advanced tools
export {
    browserAutoScroll,
    browserBatchFetch,
    browserConnectElectron,
    browserExtractArticle,
    browserFormState,
    browserInterceptRead,
    browserInterceptStart,
    browserNetworkRequests,
    browserScrollToElement,
    browserWaitForSelector,
    openCliTools,
} from "./opencli-tools.js";

// Export Playwright passthrough backend
export { PlaywrightPassthroughBackend } from "./playwright-backend.js";
// Export popup guard utilities
export { attachPopupGuard, dismissCookieBanner, dismissOverlayModals } from "./popup-guard.js";
// Export types
export type {
    BrowserConfig,
    BrowserContext,
    BrowserMode,
    ChromeBridgeCommand,
    ChromeBridgeEvent,
    ChromeBridgeResponse,
    ChromeTabInfo,
    ClickOptions,
    ElementCache,
    ElementHandle,
    FrameScanResult,
    InteractiveElement,
    Page,
    PageScanResult,
    PlaywrightModule,
    TabInfo,
} from "./types.js";
// Export video control tool
export { browserVideoControl } from "./video-control.js";

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

import { browserMultiAction, browserParallelActions, browserParallelTabs } from "./advanced.js";
import { browserHandleCaptcha } from "./captcha.js";
import {
    browserAnalyze,
    browserCacheActions,
    browserExtract,
    browserRecallStrategy,
    browserReplayActions,
    browserRunJs,
    browserSaveStrategy,
    browserSelect,
    browserUploadFile,
    browserWait,
} from "./extraction.js";
import {
    browserClick,
    browserClickAt,
    browserDrag,
    browserHoldClick,
    browserHover,
    browserKeyboard,
    browserRightClick,
    browserScroll,
    browserScrollElement,
    browserType,
} from "./interaction.js";
import { browserChromeStatus, browserSetMode } from "./mode-tools.js";
import {
    browserBack,
    browserClose as browserCloseTool,
    browserNavigate,
    browserScan,
    browserSwitchTab,
} from "./navigation.js";
import { openCliTools } from "./opencli-tools.js";
import { browserVideoControl } from "./video-control.js";

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
    // OpenCLI-inspired tools
    ...openCliTools,
    // Chrome Extension Mode
    browserSetMode,
    browserChromeStatus,
];
