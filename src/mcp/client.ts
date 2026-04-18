// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

// ── Types ─────────────────────────────────────

interface MCPServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface ConnectedServer {
    name: string;
    client: Client;
    tools: ChatCompletionTool[];
    isStoreItem?: boolean;
}

// ── Store MCP config path ─────────────────────

const STORE_MCP_CONFIG_PATH = path.join(homedir(), ".atlas", "store", "mcp-servers.json");

// ── State ─────────────────────────────────────

const connectedServers = new Map<string, ConnectedServer>();

// ── Initialize MCP Servers ────────────────────

export async function initMCPServers(configPath = "mcp-servers.json"): Promise<void> {
    // 1. Load project-level MCP config
    const fullPath = path.resolve(configPath);
    let config: Record<string, MCPServerConfig> = {};

    if (fs.existsSync(fullPath)) {
        try {
            config = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, MCPServerConfig>;
        } catch (err) {
            console.error("Failed to load MCP config:", (err as Error).message);
        }
    } else {
        console.log("ℹ️  No MCP server config found (mcp-servers.json).");
    }

    // 2. Load store-installed MCP servers
    if (fs.existsSync(STORE_MCP_CONFIG_PATH)) {
        try {
            const storeConfig = JSON.parse(fs.readFileSync(STORE_MCP_CONFIG_PATH, "utf-8")) as Record<string, MCPServerConfig>;
            // Merge store config (store servers override project servers with same name)
            config = { ...config, ...storeConfig };
            console.log(`🔌 Found ${Object.keys(storeConfig).length} store MCP server(s)`);
        } catch (err) {
            console.error("Failed to load store MCP config:", (err as Error).message);
        }
    }

    // 3. Connect all servers
    for (const [name, serverConfig] of Object.entries(config)) {
        try {
            const isStore = name.startsWith("store_");
            await connectServer(name, serverConfig, isStore);
            console.log(`🔌 MCP server connected${isStore ? " (store)" : ""}: ${name}`);
        } catch (err) {
            console.error(`❌ MCP server "${name}" failed to connect:`, (err as Error).message);
        }
    }
}

// ── Connect to MCP Server ─────────────────────

async function connectServer(name: string, config: MCPServerConfig, isStoreItem = false): Promise<void> {
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });

    const client = new Client({
        name: "atlas",
        version: "0.2.0",
    });

    await client.connect(transport);

    // List available tools
    const toolsResult = await client.listTools();
    const tools: ChatCompletionTool[] = toolsResult.tools.map((t) => ({
        type: "function" as const,
        function: {
            name: `mcp_${name}__${t.name}`,
            description: `[MCP:${name}] ${t.description || t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
        },
    }));

    connectedServers.set(name, { name, client, tools, isStoreItem });
}

// ── Dynamic Server Connection (for hot-reload) ─

/**
 * Connect a new MCP server dynamically (used by store hot-reload)
 */
export async function connectMCPServer(name: string, config: MCPServerConfig): Promise<void> {
    // Disconnect if already connected
    if (connectedServers.has(name)) {
        await disconnectMCPServer(name);
    }

    await connectServer(name, config, true);
    console.log(`🔌 MCP server "${name}" connected (hot-reload)`);
}

/**
 * Disconnect an MCP server (used by store uninstall)
 */
export async function disconnectMCPServer(name: string): Promise<void> {
    const server = connectedServers.get(name);
    if (server) {
        try {
            await server.client.close();
        } catch { /* ignore close errors */ }
        connectedServers.delete(name);
        console.log(`🔌 MCP server "${name}" disconnected`);
    }
}

// ── Get MCP Tool Schemas ──────────────────────

export function getMCPToolSchemas(): ChatCompletionTool[] {
    const allTools: ChatCompletionTool[] = [];
    for (const server of connectedServers.values()) {
        allTools.push(...server.tools);
    }
    return allTools;
}

// ── Execute MCP Tool ──────────────────────────

export async function executeMCPTool(
    fullName: string,
    input: Record<string, unknown>
): Promise<string> {
    // Parse mcp_<server>__<toolname> (double-underscore separator)
    const withoutPrefix = fullName.replace("mcp_", "");
    const separatorIdx = withoutPrefix.indexOf("__");
    const serverName = separatorIdx !== -1 ? withoutPrefix.substring(0, separatorIdx) : withoutPrefix;
    const toolName = separatorIdx !== -1 ? withoutPrefix.substring(separatorIdx + 2) : "";

    const server = connectedServers.get(serverName);
    if (!server) {
        return JSON.stringify({ error: `MCP server "${serverName}" not connected.` });
    }

    try {
        const result = await server.client.callTool({ name: toolName, arguments: input });
        return JSON.stringify(result);
    } catch (err) {
        return JSON.stringify({ error: `MCP tool failed: ${(err as Error).message}` });
    }
}

// ── Check if Tool is MCP ──────────────────────

export function isMCPTool(name: string): boolean {
    return name.startsWith("mcp_");
}

// ── Cleanup ───────────────────────────────────

export async function closeMCPServers(): Promise<void> {
    for (const server of connectedServers.values()) {
        try {
            await server.client.close();
        } catch { /* ignore */ }
    }
    connectedServers.clear();
}
