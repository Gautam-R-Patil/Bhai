// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Plugin System ─────────────────────────────
// Trait-based interfaces for Provider, Channel, Tool, Memory

// ── Trait Interfaces ──────────────────────────

export interface ProviderPlugin {
    name: string;
    type: "provider";
    chat(params: Record<string, unknown>): Promise<unknown>;
}

export interface ChannelPlugin {
    name: string;
    type: "channel";
    send(message: string, target: string): Promise<void>;
    onMessage(handler: (msg: { text: string; sender: string }) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface ToolPlugin {
    name: string;
    type: "tool";
    schema: Record<string, unknown>;
    execute(input: Record<string, unknown>): Promise<string>;
}

export interface MemoryPlugin {
    name: string;
    type: "memory";
    store(key: string, value: unknown): Promise<void>;
    retrieve(query: string): Promise<unknown[]>;
    delete(key: string): Promise<void>;
}

export type Plugin = ProviderPlugin | ChannelPlugin | ToolPlugin | MemoryPlugin;

// ── Registry ──────────────────────────────────

const plugins = new Map<string, Plugin>();

export function registerPlugin(plugin: Plugin): void {
    plugins.set(`${plugin.type}:${plugin.name}`, plugin);
    console.log(`🔌 Plugin registered: ${plugin.type}/${plugin.name}`);
}

export function getPlugin<T extends Plugin>(type: string, name: string): T | null {
    return (plugins.get(`${type}:${name}`) as T) || null;
}

export function getPluginsByType<T extends Plugin>(type: string): T[] {
    return Array.from(plugins.values()).filter((p) => p.type === type) as T[];
}

export function listPlugins(): Array<{ type: string; name: string }> {
    return Array.from(plugins.values()).map((p) => ({ type: p.type, name: p.name }));
}

// ── Load from Config ──────────────────────────

export async function loadPluginConfig(configPath = "plugins.json"): Promise<void> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fullPath = path.resolve(configPath);

    if (!fs.existsSync(fullPath)) {
        console.log("ℹ️  No plugins.json found. Skipping plugin loading.");
        return;
    }

    try {
        const config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        console.log(`🔌 Plugin config loaded: ${Object.keys(config).length} entries`);
        // Plugins are registered programmatically — config maps interface → implementation
    } catch (err) {
        console.error("Plugin config error:", (err as Error).message);
    }
}
