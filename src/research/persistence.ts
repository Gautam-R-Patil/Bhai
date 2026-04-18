// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — State persistence + memory integration

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ResearchState, StructuredFinding } from "./types.js";
import { RESEARCH_DIR } from "./profiles.js";

// ── State Persistence ────────────────────────

export async function saveResearchState(state: ResearchState): Promise<void> {
    try {
        await fs.mkdir(RESEARCH_DIR, { recursive: true });
        const filePath = join(RESEARCH_DIR, `${state.research.id}.state.json`);
        await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    } catch (err) {
        console.warn(`[RESEARCH] Failed to save state:`, (err as Error).message);
    }
}

export async function loadResearchState(researchId: string): Promise<ResearchState | null> {
    try {
        const filePath = join(RESEARCH_DIR, `${researchId}.state.json`);
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data);
    } catch { return null; }
}

export async function deleteResearchState(researchId: string): Promise<void> {
    try {
        const filePath = join(RESEARCH_DIR, `${researchId}.state.json`);
        await fs.unlink(filePath);
    } catch {}
}

export async function listIncompleteResearches(): Promise<string[]> {
    try {
        await fs.mkdir(RESEARCH_DIR, { recursive: true });
        const files = await fs.readdir(RESEARCH_DIR);
        const stateFiles = files.filter(f => f.endsWith(".state.json"));
        const incomplete: string[] = [];

        for (const f of stateFiles) {
            try {
                const data = JSON.parse(await fs.readFile(join(RESEARCH_DIR, f), "utf-8"));
                if (data.research?.status === "running") {
                    incomplete.push(data.research.id);
                }
            } catch {}
        }
        return incomplete;
    } catch { return []; }
}

// ── Memory Integration ───────────────────────
// Store research findings in the memory system so the agent can answer
// follow-up questions about the research in future conversations.

export async function storeResearchInMemory(
    topic: string,
    findings: StructuredFinding[],
    report: string,
): Promise<void> {
    try {
        const { remember } = await import("../memory/sqlite.js");

        // Store executive summary as high-importance memory
        const summaryMatch = report.match(/## Executive Summary\n([\s\S]*?)(?=\n## )/);
        if (summaryMatch) {
            remember(
                `Deep research completed on "${topic}": ${summaryMatch[1].trim().substring(0, 500)}`,
                "research",
                `research,${topic.substring(0, 50)}`,
                9,
            );
        }

        // Store strong findings (up to 15)
        const strongFindings = findings
            .filter(f => f.confidence === "strong")
            .slice(0, 15);

        for (const f of strongFindings) {
            remember(
                `[Research: ${topic}] ${f.text} (Source: ${f.sourceTitle})`,
                "research",
                `research,${topic.substring(0, 30)},${f.category}`,
                7,
            );
        }

        // Store moderate findings (up to 10)
        const moderateFindings = findings
            .filter(f => f.confidence === "moderate")
            .slice(0, 10);

        for (const f of moderateFindings) {
            remember(
                `[Research: ${topic}] ${f.text}`,
                "research",
                `research,${topic.substring(0, 30)},${f.category}`,
                5,
            );
        }

        // Store the report file path
        remember(
            `Research report on "${topic}" saved to ~/Documents/Research/. Use check_deep_research to read.`,
            "research",
            `research,${topic.substring(0, 50)},report`,
            8,
        );

        console.log(`[RESEARCH] Stored ${strongFindings.length + moderateFindings.length + 2} research memories for follow-up queries`);
    } catch (err) {
        console.warn(`[RESEARCH] Failed to store in memory:`, (err as Error).message);
    }
}
