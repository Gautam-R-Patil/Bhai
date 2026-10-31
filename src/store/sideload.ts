// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── ClawHub / External Skill Sideloading ────────
// Allows power users to import external skill files (e.g., from ClawHub/OpenClaw)
// into Bhai's local skill store. Unsupported — use at your own risk.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import type { ToolDefinition } from "../tools/get-current-time.js";
import { scanSkillContent as deepScanSkillContent } from "../security/skill-scanner.js";
import type { SkillScanResult } from "../security/skill-scanner.js";
import { getBhaiHome } from "../config/paths.js";

const STORE_BASE = join(getBhaiHome(), "store");
const SKILLS_PATH = join(STORE_BASE, "skills");
const MANIFEST_PATH = join(STORE_BASE, "installs.json");

// ── Category auto-classifier ─────────────────────
// Maps keywords in skill descriptions to Bhai tool router categories.

const CATEGORY_KEYWORDS: Record<string, string[]> = {
    media: ["music", "spotify", "audio", "video", "media", "play", "sound", "song", "playlist", "sonos", "speaker", "gif", "image", "photo", "visualization"],
    browser: ["browser", "web", "scrape", "navigate", "url", "http", "html", "chrome", "safari", "firefox"],
    shell: ["shell", "terminal", "command", "cli", "bash", "zsh", "exec", "script", "brew", "npm", "pip"],
    file_system: ["file", "directory", "folder", "read", "write", "edit", "create", "delete", "path", "fs"],
    communication: ["email", "message", "slack", "discord", "telegram", "chat", "sms", "notification"],
    scheduling: ["calendar", "reminder", "schedule", "event", "todo", "task", "alarm", "cron"],
    web_search: ["search", "google", "find", "lookup", "research", "weather", "news"],
    github: ["github", "git", "repo", "pr", "issue", "commit", "branch", "workflow"],
    os_control: ["screenshot", "click", "keyboard", "mouse", "window", "app", "automation", "applescript", "macos"],
    memory: ["memory", "remember", "note", "knowledge", "learn", "improve", "self-improving"],
    system_controls: ["volume", "brightness", "wifi", "bluetooth", "system", "settings"],
    google_api: ["google", "gmail", "gdrive", "google calendar", "sheets"],
};

function classifyCategories(name: string, description: string): string[] {
    const text = `${name} ${description}`.toLowerCase();
    const matches: string[] = [];

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        for (const kw of keywords) {
            if (text.includes(kw)) {
                matches.push(category);
                break;
            }
        }
    }

    // Default to "shell" if nothing matches (most skills are CLI wrappers)
    return matches.length > 0 ? matches : ["shell"];
}

// ── Manifest operations ──────────────────────────

interface SideloadManifest {
    items: Record<string, {
        itemId: string;
        type: string;
        name: string;
        version: string;
        installedAt: number;
        autoUpdate: boolean;
        path: string;
    }>;
    lastUpdated: number;
}

async function loadManifest(): Promise<SideloadManifest> {
    try {
        if (existsSync(MANIFEST_PATH)) {
            return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf-8"));
        }
    } catch { /* ignore */ }
    return { items: {}, lastUpdated: Date.now() };
}

async function saveManifest(manifest: SideloadManifest): Promise<void> {
    manifest.lastUpdated = Date.now();
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── Security scan (basic pattern matching) ───────

interface SecurityResult {
    safe: boolean;
    warnings: string[];
}

function scanSkillContent(content: string): SecurityResult {
    const warnings: string[] = [];

    // Check for prompt injection patterns
    const injectionPatterns = [
        /<system>/i,
        /<\/system>/i,
        /ignore previous instructions/i,
        /ignore all previous/i,
        /you are now/i,
        /new identity/i,
        /forget everything/i,
        /override.*system.*prompt/i,
    ];
    for (const pattern of injectionPatterns) {
        if (pattern.test(content)) {
            warnings.push(`Potential prompt injection: ${pattern.source}`);
        }
    }

    // Check for suspicious URLs (data exfiltration)
    const urlPattern = /https?:\/\/[^\s"'<>]+/gi;
    const urls = content.match(urlPattern) || [];
    const suspiciousUrls = urls.filter(url => {
        const u = url.toLowerCase();
        return u.includes("webhook") || u.includes("exfil") || u.includes("ngrok") ||
            u.includes("requestbin") || u.includes("pipedream") || u.includes("burpcollaborator");
    });
    if (suspiciousUrls.length > 0) {
        warnings.push(`Suspicious URLs found: ${suspiciousUrls.join(", ")}`);
    }

    // Check for credential access patterns
    const credPatterns = [
        /process\.env\[/,
        /\$[A-Z_]+_KEY/,
        /\$[A-Z_]+_TOKEN/,
        /\$[A-Z_]+_SECRET/,
        /cat.*\.ssh/,
        /cat.*\.aws/,
        /cat.*credentials/,
    ];
    for (const pattern of credPatterns) {
        if (pattern.test(content)) {
            warnings.push(`Potential credential access: ${pattern.source}`);
        }
    }

    return { safe: warnings.length === 0, warnings };
}

// ── Validate dependencies ────────────────────────

interface DependencyCheck {
    met: boolean;
    missing_bins: string[];
    missing_env: string[];
}

async function checkDependencies(metadata: Record<string, unknown>): Promise<DependencyCheck> {
    const openclaw = (metadata.openclaw || metadata.clawdbot || metadata.clawdis) as Record<string, unknown> | undefined;
    if (!openclaw) return { met: true, missing_bins: [], missing_env: [] };

    const requires = openclaw.requires as Record<string, unknown> | undefined;
    if (!requires) return { met: true, missing_bins: [], missing_env: [] };

    const missingBins: string[] = [];
    const missingEnv: string[] = [];

    // Check binaries
    const bins = (requires.bins || []) as string[];
    const { execFile: ef } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(ef);

    for (const bin of bins) {
        try {
            await execAsync("which", [bin], { timeout: 3000 });
        } catch {
            missingBins.push(bin);
        }
    }

    // Check env vars
    const envVars = (requires.env || []) as string[];
    for (const env of envVars) {
        if (!process.env[env]) {
            missingEnv.push(env);
        }
    }

    return {
        met: missingBins.length === 0 && missingEnv.length === 0,
        missing_bins: missingBins,
        missing_env: missingEnv,
    };
}

// ── Main sideload function ───────────────────────

export async function sideloadSkill(skillPath: string): Promise<{
    success: boolean;
    slug?: string;
    warnings?: string[];
    error?: string;
    scanResult?: SkillScanResult;
}> {
    // Read the skill file
    const content = await fs.readFile(skillPath, "utf-8");

    // Parse frontmatter (gray-matter can throw on severely malformed YAML)
    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
        const parsed = matter(content);
        frontmatter = parsed.data;
        body = parsed.content;
    } catch (err) {
        return { success: false, error: `Failed to parse skill frontmatter: ${(err as Error).message}` };
    }
    const name = frontmatter.name as string;
    if (!name) {
        return { success: false, error: "Skill file has no 'name' in frontmatter." };
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    const description = (frontmatter.description as string) || "";
    const version = (frontmatter.version as string) || "1.0.0";
    const metadata = (frontmatter.metadata || {}) as Record<string, unknown>;

    // Legacy prompt-injection scan (kept for defense-in-depth)
    const legacySecurity = scanSkillContent(body);

    // Deep behavioral scan (permission-tier + pattern matching)
    const deepScan = deepScanSkillContent(body);

    // Block critical-risk skills outright
    if (deepScan.riskLevel === "critical") {
        console.error(`🚫 SIDELOAD BLOCKED — critical risk detected for "${name}":`);
        for (const w of deepScan.warnings) {
            console.error(`   - ${w}`);
        }
        return {
            success: false,
            error: `Skill blocked: critical security risk detected. ${deepScan.warnings.length} issue(s) found.`,
            warnings: deepScan.warnings,
        };
    }

    // Log high-risk warnings prominently
    if (deepScan.riskLevel === "high") {
        console.warn(`⚠️  SIDELOAD HIGH-RISK WARNING for "${name}":`);
        for (const w of deepScan.warnings) {
            console.warn(`   - ${w}`);
        }
    }

    // Also log legacy injection warnings
    if (!legacySecurity.safe) {
        console.warn(`⚠️  SIDELOAD PROMPT-INJECTION WARNING for "${name}":`);
        for (const w of legacySecurity.warnings) {
            console.warn(`   - ${w}`);
        }
    }

    // Dependency check
    const deps = await checkDependencies(metadata);
    const warnings = [...legacySecurity.warnings, ...deepScan.warnings];
    if (deps.missing_bins.length > 0) {
        warnings.push(`Missing binaries: ${deps.missing_bins.join(", ")}`);
    }
    if (deps.missing_env.length > 0) {
        warnings.push(`Missing env vars: ${deps.missing_env.join(", ")}`);
    }

    // Auto-classify categories
    const categories = classifyCategories(name, description);

    // Skills now live SERVER-SIDE in the user's user_prompt_addenda table.
    // Sideload pushes the parsed skill body directly to the addendum API
    // (kind:"skill", slug:"skill-<slug>"); no local .md file is written.
    try {
        const { getSessionToken } = await import("../session.js");
        const { getConvexSiteUrl } = await import("../config/keys.js");
        const { encryptedFetch } = await import("../crypto-transport.js");
        const token = await getSessionToken();
        if (!token) {
            throw new Error("Not authenticated — cannot persist sideloaded skill");
        }
        const skillSlug = slug.startsWith("skill-") ? slug : `skill-${slug}`;
        const res = await encryptedFetch(`${getConvexSiteUrl()}/api/user/addendum/upsert`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                slug: skillSlug,
                kind: "skill",
                title: name,
                content: body,
                reason: `Sideloaded from ${basename(skillPath)}`,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(`server upsert failed: ${err.error || `HTTP ${res.status}`}`);
        }
    } catch (err) {
        throw new Error(`Sideload server-push failed: ${(err as Error).message}`);
    }

    // Update manifest (informational only — tracks sideloaded items so the user
    // can list/uninstall them from the UI)
    const manifest = await loadManifest();
    manifest.items[slug] = {
        itemId: `sideload_${slug}`,
        type: "skill",
        name,
        version,
        installedAt: Date.now(),
        autoUpdate: false,
        path: `server://user_prompt_addenda/skill-${slug}`,
    };
    await saveManifest(manifest);

    console.log(`📥 Sideloaded skill: ${name} (${slug}) → server addendum skill-${slug}`);
    if (warnings.length > 0) {
        console.warn(`⚠️  ${warnings.length} warning(s) — review before use`);
    }

    return { success: true, slug, warnings: warnings.length > 0 ? warnings : undefined, scanResult: deepScan };
}

// ── Agent tool for sideloading ───────────────────

export const sideloadSkillTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "sideload_skill",
            description: "Sideload an external skill file (e.g., from ClawHub/OpenClaw) into Bhai. The skill must be a markdown file with YAML frontmatter. WARNING: Sideloaded skills are unvetted third-party content — use at your own risk.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Local file path to the SKILL.md file to sideload",
                    },
                    force: {
                        type: "boolean",
                        description: "Force install even if security warnings are found (default: false)",
                    },
                },
                required: ["path"],
            },
        },
    },

    async handler(input) {
        const skillPath = input.path as string;
        const force = (input.force as boolean) || false;

        try {
            if (!existsSync(skillPath)) {
                return JSON.stringify({ error: `File not found: ${skillPath}` });
            }

            const result = await sideloadSkill(skillPath);

            if (!result.success) {
                return JSON.stringify({
                    success: false,
                    error: result.error,
                    warnings: result.warnings,
                    scanResult: result.scanResult,
                });
            }

            // Block if security warnings and not forced
            if (result.warnings && result.warnings.length > 0 && !force) {
                const hasSecurityIssue = result.warnings.some(w =>
                    w.includes("injection") || w.includes("Suspicious URL") || w.includes("credential") ||
                    w.includes("[CRITICAL]") || w.includes("[HIGH]")
                );
                if (hasSecurityIssue) {
                    return JSON.stringify({
                        success: false,
                        error: "Security warnings detected. Use force=true to install anyway.",
                        warnings: result.warnings,
                        slug: result.slug,
                        scanResult: result.scanResult,
                    });
                }
            }

            return JSON.stringify({
                success: true,
                slug: result.slug,
                warnings: result.warnings,
                scanResult: result.scanResult,
                note: "⚠️ Sideloaded skill from unvetted source. Skill will be available after restart or hot-reload.",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
