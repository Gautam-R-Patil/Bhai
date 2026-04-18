// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Centralized Path Configuration ───────────────────
// Provides consistent file paths for bot-generated files.
// Uses ATLAS_WORKSPACE (set by installer) as the primary output directory.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ── ATLAS Workspace Directory ────────────────────────
// This is where all bot-generated files should be saved.
// Set by the desktop installer during setup.

function getAtlasWorkspace(): string {
    // Priority 1: Environment variable (set by desktop app)
    const envWorkspace = process.env.ATLAS_WORKSPACE;
    if (envWorkspace && fs.existsSync(envWorkspace)) {
        return envWorkspace;
    }

    // Priority 2: Default locations based on OS
    const homeDir = os.homedir();
    const defaultLocations = [
        path.join(homeDir, "Desktop", "A.T.L.A.S Files"),
        path.join(homeDir, "Documents", "A.T.L.A.S Files"),
        path.join(homeDir, ".atlas", "files"),
    ];

    for (const loc of defaultLocations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }

    // Priority 3: Create default directory
    const defaultDir = path.join(homeDir, "A.T.L.A.S Files");
    try {
        fs.mkdirSync(defaultDir, { recursive: true });
        console.log(`📁 Created ATLAS files directory: ${defaultDir}`);
        return defaultDir;
    } catch {
        // Fallback to temp directory
        return os.tmpdir();
    }
}

// Cached workspace path
let _workspacePath: string | null = null;

/**
 * Get the ATLAS workspace directory where bot-generated files should be saved.
 * This is the user-facing folder for all outputs (images, documents, downloads, etc.)
 */
export function getWorkspaceDir(): string {
    if (!_workspacePath) {
        _workspacePath = getAtlasWorkspace();
    }
    return _workspacePath;
}

/**
 * Get a subdirectory within the workspace for organized file storage.
 * Creates the subdirectory if it doesn't exist.
 */
export function getWorkspaceSubdir(subdir: string): string {
    const dir = path.join(getWorkspaceDir(), subdir);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ── Specific Output Directories ──────────────────────

/**
 * Directory for AI-generated images
 */
export function getImagesDir(): string {
    return getWorkspaceSubdir("Images");
}

/**
 * Directory for research reports and documents
 */
export function getDocumentsDir(): string {
    return getWorkspaceSubdir("Documents");
}

/**
 * Directory for downloaded files
 */
export function getDownloadsDir(): string {
    return getWorkspaceSubdir("Downloads");
}

/**
 * Directory for screenshots and screen captures
 */
export function getScreenshotsDir(): string {
    return getWorkspaceSubdir("Screenshots");
}

/**
 * Directory for code and project files
 */
export function getCodeDir(): string {
    return getWorkspaceSubdir("Code");
}

/**
 * Directory for temporary/working files
 */
export function getTempDir(): string {
    return getWorkspaceSubdir(".temp");
}

/**
 * Directory for exports (PDF, archives, etc.)
 */
export function getExportsDir(): string {
    return getWorkspaceSubdir("Exports");
}

/**
 * Directory for AI-generated presentations (PPTX, PDF, HTML decks).
 */
export function getPresentationsDir(): string {
    return getWorkspaceSubdir("Presentations");
}

// ── Path Helpers ─────────────────────────────────────

/**
 * Generate a unique filename with timestamp to avoid collisions.
 * @param baseName Base name for the file (e.g., "image", "report")
 * @param extension File extension (e.g., "png", "pdf")
 * @returns Full path in the appropriate workspace subdirectory
 */
export function generateFilePath(baseName: string, extension: string, subdir?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${baseName}_${timestamp}.${extension}`;
    const dir = subdir ? getWorkspaceSubdir(subdir) : getWorkspaceDir();
    return path.join(dir, filename);
}

/**
 * Generate a path for an AI-generated image.
 */
export function generateImagePath(description?: string): string {
    const baseName = description
        ? description.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
        : "image";
    return generateFilePath(baseName, "png", "Images");
}

/**
 * Generate a path for a research report.
 */
export function generateReportPath(topic?: string): string {
    const baseName = topic
        ? topic.slice(0, 40).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
        : "report";
    return generateFilePath(baseName, "md", "Documents");
}

/**
 * Generate a path for a screenshot.
 */
export function generateScreenshotPath(): string {
    return generateFilePath("screenshot", "png", "Screenshots");
}

/**
 * Check if workspace is properly configured
 */
export function isWorkspaceConfigured(): boolean {
    const workspace = getWorkspaceDir();
    return workspace !== os.tmpdir() && fs.existsSync(workspace);
}

/**
 * Get the data directory (internal bot data, not user-facing).
 * This is separate from the workspace - used for databases, caches, etc.
 */
export function getDataDir(): string {
    return process.env.ATLAS_DATA_DIR || path.resolve("data");
}
