// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// FunctionGemma Tool Router — 270M CPU model for function calling.
// 85% accuracy after fine-tuning on tool schemas. Zero API cost.

export interface FunctionGemmaResult {
    toolName: string;
    confidence: number;
    parameters: Record<string, string>;
    source: "function-gemma" | "fallback";
}

let ollamaAvailable: boolean | null = null;

export async function routeWithFunctionGemma(
    query: string,
    toolSchemas: Array<{ name: string; description: string; parameters: string[] }>,
): Promise<FunctionGemmaResult | null> {
    // Check Ollama
    if (ollamaAvailable === null) {
        try {
            const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
            const data = await resp.json() as { models: Array<{ name: string }> };
            ollamaAvailable = data.models?.some(m => m.name.includes("functiongemma")) || false;
        } catch { ollamaAvailable = false; }
    }

    if (!ollamaAvailable) return null;

    try {
        const schemaStr = toolSchemas.map(t => `${t.name}: ${t.description} (${t.parameters.join(", ")})`).join("\n");
        const resp = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "functiongemma",
                prompt: `Given these tools:\n${schemaStr}\n\nUser query: "${query}"\n\nWhich tool should be called? Respond with: TOOL: <name>\nPARAMS: <json>`,
                stream: false,
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        const data = await resp.json() as { response: string };
        const toolMatch = data.response?.match(/TOOL:\s*(\w+)/);
        if (toolMatch) {
            return { toolName: toolMatch[1], confidence: 0.8, parameters: {}, source: "function-gemma" };
        }
    } catch { /* */ }
    return null;
}
