// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Tool Composer — Compose atomic tools into higher-order composite tools.
// "search + extract + summarize" → single composite tool.

export interface CompositeToolDef {
    name: string;
    description: string;
    steps: Array<{ toolName: string; paramMapping: Record<string, string> }>;
    successCount: number;
    createdAt: string;
}

const compositions = new Map<string, CompositeToolDef>();

export function registerComposition(def: CompositeToolDef): void {
    compositions.set(def.name, def);
    console.log(`[TOOL-COMPOSER] Registered: ${def.name} (${def.steps.length} steps)`);
}

export function getComposition(name: string): CompositeToolDef | undefined {
    return compositions.get(name);
}

export function findMatchingComposition(toolSequence: string[]): CompositeToolDef | null {
    for (const comp of compositions.values()) {
        const compTools = comp.steps.map(s => s.toolName);
        if (compTools.length === toolSequence.length && compTools.every((t, i) => t === toolSequence[i])) {
            return comp;
        }
    }
    return null;
}

export function recordCompositionSuccess(name: string): void {
    const comp = compositions.get(name);
    if (comp) comp.successCount++;
}

export function getAllCompositions(): CompositeToolDef[] { return [...compositions.values()]; }
