// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A plain browse loads the browsing skill, not six skills plus the coding prompt.
import { expect, it, vi } from "vitest";

// The seeded categories (scripts/seed-system-content.ts SKILL_CATEGORIES).
const CATS: Record<string, string[]> = {
    coding_best_practices: ["shell", "file_system", "long_tasks"],
    data_scientist: ["shell", "file_system", "research"],
    devops_engineer: ["shell", "system_controls", "file_system"],
    full_stack_developer: ["shell", "file_system", "browser", "long_tasks"],
    os_automation: ["os_control", "system_controls", "app_management"],
    research_analyst: ["web_search", "research", "browser"],
    security_auditor: ["shell", "file_system", "browser"],
    technical_writer: ["file_system", "research"],
    ui_ux_designer: ["browser", "media", "file_system"],
    video_editing: ["os_control", "app_management", "media", "file_system"],
    app_navigation: ["os_control", "app_management", "system_controls"],
    gaming: ["os_control", "app_management"],
    web_browsing: ["browser", "web_search", "media", "integrations"],
    marketing: ["browser", "web_search", "integrations", "research"],
};
vi.mock("../session.js", () => ({ getSessionToken: async () => "t", handleAuthError: async () => null }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://x" }));
vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async () =>
        new Response(JSON.stringify({ skills: Object.entries(CATS).map(([slug, categories]) => ({ slug, categories, source: "system" })) })),
}));

const { initSkillMetadata, getRelevantSkillSlugs } = await import("./loader.js");
await initSkillMetadata();

it("picks the category's own skill, and others only when two of their categories are in play", () => {
    expect(getRelevantSkillSlugs(["browser", "core", "tool_creation"])).toEqual(["web_browsing"]);
    // No design/marketing/security/full-stack skill (and so no coding prompt) for a browse.
    expect(getRelevantSkillSlugs(["web_search", "research"], "plan a marketing campaign")).toEqual(
        expect.arrayContaining(["research_analyst", "marketing"]),
    );
    expect(getRelevantSkillSlugs(["shell", "file_system"])).toEqual(
        expect.arrayContaining(["coding_best_practices", "full_stack_developer", "devops_engineer"]),
    );
    // Any desktop task is os_control + app_management: no game or video skill for "open Finder".
    expect(getRelevantSkillSlugs(["os_control", "app_management"], "open Finder and show my downloads")).toEqual([
        "os_automation",
        "app_navigation",
    ]);
    expect(getRelevantSkillSlugs(["os_control", "app_management", "media"], "trim this video clip in iMovie")).toContain(
        "video_editing",
    );
    expect(getRelevantSkillSlugs(["web_search", "research"], "research the history of Mysore")).not.toContain("marketing");
    expect(getRelevantSkillSlugs(["core"])).toEqual([]);
});
