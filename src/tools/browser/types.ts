// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Module Types ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PlaywrightModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrowserContext = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Page = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ElementHandle = any;

/**
 * Represents an interactive element found during DOM scan
 */
export type EditorType =
    | "monaco"
    | "codemirror5"
    | "codemirror6"
    | "ace"
    | "quill"
    | "tinymce"
    | "prosemirror"
    | "tiptap"
    | "slate"
    | "draftjs";

export interface InteractiveElement {
    label: number;
    x: number;
    y: number;
    tag: string;
    text: string;
    atlasId: string;
    handle?: ElementHandle;
    editorType?: EditorType;
    isOCRElement?: boolean;
}

/**
 * Cache for scanned elements to avoid rescanning
 */
export interface ElementCache {
    url: string;
    timestamp: number;
    elements: InteractiveElement[];
}

/**
 * Result from scanning a single frame
 */
export interface FrameScanResult {
    label: number;
    x: number;
    y: number;
    tag: string;
    text: string;
    atlasId: string;
    score: number;
    editorType?: EditorType;
}

/**
 * Combined scan result including accessibility tree + DOM elements
 */
export interface PageScanResult {
    url: string;
    title: string;
    accessibilityTree: string; // Compact semantic view from Playwright a11y API
    elements: InteractiveElement[]; // DOM-based element list (fallback)
    text?: string;
}

/**
 * Configuration for browser context
 */
export interface BrowserConfig {
    headless: boolean;
    viewport: { width: number; height: number };
    userAgent: string;
    profileDir: string;
}

// ── Chrome Bridge Types ──────────────────────

/**
 * Info about a Chrome tab reported by the extension
 */
export interface ChromeTabInfo {
    id: number;
    index: number;
    title: string;
    url: string;
    active: boolean;
    windowId: number;
}

/**
 * Command sent from Bhai to the Chrome extension
 */
export interface ChromeBridgeCommand {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    timeout?: number;
}

/**
 * Response from the Chrome extension to Bhai
 */
export interface ChromeBridgeResponse {
    id: string;
    success: boolean;
    data?: unknown;
    error?: string;
}

/**
 * Unsolicited event from the Chrome extension
 */
export interface ChromeBridgeEvent {
    type: "tab_activated" | "tab_updated" | "tab_removed" | "extension_connected" | "extension_disconnected";
    data: unknown;
}

/**
 * Tab info used by the backend abstraction
 */
export interface TabInfo {
    index: number;
    title: string;
    url: string;
    active: boolean;
}

/**
 * Click options for backend abstraction
 */
export interface ClickOptions {
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: string[];
    waitAfterMs?: number;
}

/**
 * Browser backend mode
 */
export type BrowserMode = "playwright" | "chrome";
