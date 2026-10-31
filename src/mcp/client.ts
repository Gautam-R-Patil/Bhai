// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "node:fs";
import path from "node:path";
import { getBhaiHome, LEGACY_HOME } from "../config/paths.js";
import { checkPackageForMalware } from "../security/osv-check.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

// MCP tool descriptions arrive from third-party servers and feed straight
// into the LLM context. Strip prompt-injection scaffolding (system tags,
// instruction markers) and cap the length so a hostile server can't burn
// the context window or override agent instructions.
const PROMPT_INJECTION_TAGS = [
    /<\/?system[^>]*>/gi,
    /<\/?critical[^>]*>/gi,
    /<\/?instructions?[^>]*>/gi,
    /<\/?important[^>]*>/gi,
    /<\/?user[^>]*>/gi,
    /<\/?assistant[^>]*>/gi,
    /\[INST\][\s\S]*?\[\/INST\]/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /\[SYSTEM NOTE[^\]]*\]/gi,
    /\[INSTRUCTIONS?\]/gi,
];

export function sanitizeMcpDescription(name: string, raw: string | undefined): string {
    let s = raw && typeof raw === "string" ? raw : name;
    for (const re of PROMPT_INJECTION_TAGS) {
        s = s.replace(re, "");
    }
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > 500) s = s.slice(0, 500) + "…";
    return `[MCP:${name} — third-party advertising, not authoritative] ${s}`;
}

// Only these env vars are inherited from the parent process when spawning an
// MCP server. Server-specific overrides from config.env are layered on top.
const MCP_ENV_ALLOWLIST = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"]);

export function buildMcpEnv(serverEnv?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of MCP_ENV_ALLOWLIST) {
        const v = process.env[k];
        if (typeof v === "string") env[k] = v;
    }
    if (serverEnv) {
        for (const [k, v] of Object.entries(serverEnv)) {
            if (typeof v === "string") env[k] = v;
        }
    }
    return env;
}

// ── Types ─────────────────────────────────────

export interface MCPServerConfig {
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

const STORE_MCP_CONFIG_PATH = path.join(getBhaiHome(), "store", "mcp-servers.json");

// ── State ─────────────────────────────────────

const connectedServers = new Map<string, ConnectedServer>();

// ── Initialize MCP Servers ────────────────────

/**
 * Store servers installed before the ATLAS → Bhai rename point at absolute ~/.atlas paths;
 * the copied ~/.bhai holds the same files, so run those instead of the legacy tree.
 */
export function withCurrentHome(
    config: Record<string, MCPServerConfig>,
    home = getBhaiHome(),
): Record<string, MCPServerConfig> {
    if (home === LEGACY_HOME) return config;
    const fix = (s: string) => (s.startsWith(LEGACY_HOME + path.sep) ? home + s.slice(LEGACY_HOME.length) : s);
    return Object.fromEntries(
        Object.entries(config).map(([name, c]) => [name, { ...c, command: fix(c.command), args: c.args?.map(fix) }]),
    );
}

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
            const storeConfig = withCurrentHome(
                JSON.parse(fs.readFileSync(STORE_MCP_CONFIG_PATH, "utf-8")) as Record<string, MCPServerConfig>,
            );
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
    const mal = await checkPackageForMalware(config.command, config.args || []);
    if (mal.blocked) {
        const ids = mal.advisoryIds.join(", ");
        console.error(`🛑 MCP server "${name}" blocked — OSV malware advisory (${ids}) for ${mal.pkg?.ecosystem} package`);
        throw new Error(`OSV malware check blocked "${name}": ${ids}`);
    }

    // The MCP SDK loads when the first server connects, not at boot.
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: buildMcpEnv(config.env),
    });

    const client = new Client({
        name: "bhai",
        version: "0.2.0",
    });

    await client.connect(transport);

    // List available tools
    const toolsResult = await client.listTools();
    const tools: ChatCompletionTool[] = toolsResult.tools.map((t) => ({
        type: "function" as const,
        function: {
            name: `mcp_${name}__${t.name}`,
            description: sanitizeMcpDescription(name, t.description),
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
