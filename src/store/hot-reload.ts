// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Hot-reload system for store items.
// Allows injecting newly installed items without restarting A.T.L.A.S.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import type { StoreItem, StoreItemType, StoreMCPConfig } from "./types.js";
import { SKILLS_PATH, MCP_PATH, TOOLS_PATH, MCP_CONFIG_PATH } from "./installer.js";

// ── Hot-reload state ──────────────────────────────

let skillsReloadCallback: (() => void) | null = null;
let mcpConnectCallback: ((name: string, config: StoreMCPConfig[string]) => Promise<void>) | null = null;
let mcpDisconnectCallback: ((name: string) => Promise<void>) | null = null;
let toolRegisterCallback: ((toolPath: string) => Promise<void>) | null = null;
let toolUnregisterCallback: ((slug: string) => void) | null = null;
let templatesReloadCallback: (() => void) | null = null;

// ── Register callbacks from other modules ─────────

/**
 * Register the skills reload callback
 * Called by skills/loader.ts during initialization
 */
export function registerSkillsReloader(callback: () => void): void {
  skillsReloadCallback = callback;
}

/**
 * Register MCP server callbacks
 * Called by mcp/client.ts during initialization
 */
export function registerMCPCallbacks(
  connect: (name: string, config: StoreMCPConfig[string]) => Promise<void>,
  disconnect: (name: string) => Promise<void>
): void {
  mcpConnectCallback = connect;
  mcpDisconnectCallback = disconnect;
}

/**
 * Register tool callbacks
 * Called by tools/index.ts during initialization
 */
export function registerToolCallbacks(
  register: (toolPath: string) => Promise<void>,
  unregister: (slug: string) => void
): void {
  toolRegisterCallback = register;
  toolUnregisterCallback = unregister;
}

/**
 * Register the document-templates reload callback.
 * Called by the document tools during initialization so newly installed
 * templates (dropped into ~/.atlas/store/templates/) are picked up without a restart.
 */
export function registerTemplatesReloader(callback: () => void): void {
  templatesReloadCallback = callback;
}

/**
 * Trigger a templates rescan. No-op if no reloader is registered.
 */
export function reloadTemplates(): void {
  if (templatesReloadCallback) {
    try { templatesReloadCallback(); } catch (err) {
      console.warn("🏪 Hot-reload: templates reload failed:", (err as Error).message);
    }
  }
}

// ── Main hot-reload function ──────────────────────

/**
 * Inject a newly installed item into the running system without restart
 */
export async function hotReloadItem(item: StoreItem): Promise<void> {
  switch (item.type) {
    case "skill":
      await hotReloadSkill(item);
      break;
    case "mcp":
      await hotReloadMCP(item);
      break;
    case "tool":
      await hotReloadTool(item);
      break;
    case "dynamic":
      console.log(`🔥 hot-reload: dynamic tool '${item.slug}' detected (registration in phase 2)`);
      break;
    default:
      console.warn(`🔥 hot-reload: unknown item type '${(item as { type?: string }).type}' for slug '${item.slug}'; ignoring`);
  }
}

/**
 * Hot-unload an item from the running system
 */
export async function hotUnloadItem(item: StoreItem): Promise<void> {
  switch (item.type) {
    case "skill":
      await hotUnloadSkill(item);
      break;
    case "mcp":
      await hotUnloadMCP(item);
      break;
    case "tool":
      await hotUnloadTool(item);
      break;
    case "dynamic":
      console.log(`🔥 hot-unload: dynamic tool '${item.slug}' detected (unregistration in phase 2)`);
      break;
    default:
      console.warn(`🔥 hot-unload: unknown item type '${(item as { type?: string }).type}' for slug '${item.slug}'; ignoring`);
  }
}

// ── Skill hot-reload ──────────────────────────────

async function hotReloadSkill(_item: StoreItem): Promise<void> {
  if (!skillsReloadCallback) {
    console.warn("🏪 Hot-reload: Skills reloader not registered");
    return;
  }

  // Simply re-run the skills loader to pick up new skills
  skillsReloadCallback();
  console.log("🏪 Hot-reload: Skills reloaded");
}

async function hotUnloadSkill(_item: StoreItem): Promise<void> {
  // Skills are stateless - just reload without the removed skill
  if (skillsReloadCallback) {
    skillsReloadCallback();
    console.log("🏪 Hot-reload: Skills reloaded (after removal)");
  }
}

// ── MCP hot-reload ────────────────────────────────

async function hotReloadMCP(item: StoreItem): Promise<void> {
  if (!mcpConnectCallback) {
    console.warn("🏪 Hot-reload: MCP connect callback not registered");
    return;
  }

  const mcpPath = join(MCP_PATH, item.slug);
  const serverName = `store_${item.slug}`;

  // Read the MCP config
  let config: StoreMCPConfig[string];

  const atlasConfigPath = join(mcpPath, "atlas.config.json");
  if (existsSync(atlasConfigPath)) {
    const atlasConfig = JSON.parse(await readFile(atlasConfigPath, "utf-8"));
    if (atlasConfig.mcp) {
      config = {
        command: atlasConfig.mcp.command || "node",
        args: (atlasConfig.mcp.args || ["dist/index.js"]).map((arg: string) =>
          arg.startsWith("/") ? arg : join(mcpPath, arg)
        ),
        ...(atlasConfig.mcp.env ? { env: atlasConfig.mcp.env } : {}),
      };
    } else {
      config = {
        command: "node",
        args: [join(mcpPath, "dist", "index.js")],
      };
    }
  } else {
    config = {
      command: "node",
      args: [join(mcpPath, "dist", "index.js")],
    };
  }

  try {
    await mcpConnectCallback(serverName, config);
    console.log(`🏪 Hot-reload: MCP server "${serverName}" connected`);
  } catch (err) {
    console.error(`🏪 Hot-reload: Failed to connect MCP "${serverName}":`, (err as Error).message);
    throw err;
  }
}

async function hotUnloadMCP(item: StoreItem): Promise<void> {
  if (!mcpDisconnectCallback) {
    console.warn("🏪 Hot-reload: MCP disconnect callback not registered");
    return;
  }

  const serverName = `store_${item.slug}`;

  try {
    await mcpDisconnectCallback(serverName);
    console.log(`🏪 Hot-reload: MCP server "${serverName}" disconnected`);
  } catch (err) {
    console.error(`🏪 Hot-reload: Failed to disconnect MCP "${serverName}":`, (err as Error).message);
  }
}

// ── Tool hot-reload ───────────────────────────────

async function hotReloadTool(item: StoreItem): Promise<void> {
  if (!toolRegisterCallback) {
    console.warn("🏪 Hot-reload: Tool register callback not registered");
    return;
  }

  const toolPath = join(TOOLS_PATH, item.slug);

  try {
    await toolRegisterCallback(toolPath);
    console.log(`🏪 Hot-reload: Tool "${item.slug}" registered`);
  } catch (err) {
    console.error(`🏪 Hot-reload: Failed to register tool "${item.slug}":`, (err as Error).message);
    throw err;
  }
}

async function hotUnloadTool(item: StoreItem): Promise<void> {
  if (!toolUnregisterCallback) {
    console.warn("🏪 Hot-reload: Tool unregister callback not registered");
    return;
  }

  toolUnregisterCallback(item.slug);
  console.log(`🏪 Hot-reload: Tool "${item.slug}" unregistered`);
}

// ── Reload all store items ────────────────────────

/**
 * Reload all installed store items
 * Called during startup to ensure everything is loaded
 */
export async function reloadAllStoreItems(): Promise<void> {
  // Skills
  if (skillsReloadCallback) {
    skillsReloadCallback();
  }

  // MCP servers
  if (mcpConnectCallback && existsSync(MCP_CONFIG_PATH)) {
    try {
      const config: StoreMCPConfig = JSON.parse(await readFile(MCP_CONFIG_PATH, "utf-8"));
      for (const [name, serverConfig] of Object.entries(config)) {
        try {
          await mcpConnectCallback(name, serverConfig);
        } catch (err) {
          console.error(`🏪 Failed to load store MCP "${name}":`, (err as Error).message);
        }
      }
    } catch {
      // Config file doesn't exist or is invalid
    }
  }

  // Tools
  if (toolRegisterCallback && existsSync(TOOLS_PATH)) {
    const { readdirSync } = await import("fs");
    const entries = readdirSync(TOOLS_PATH, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const toolPath = join(TOOLS_PATH, entry.name);
        try {
          await toolRegisterCallback(toolPath);
        } catch (err) {
          console.error(`🏪 Failed to load store tool "${entry.name}":`, (err as Error).message);
        }
      }
    }
  }

  // Templates (bundled + ~/.atlas/store/templates/)
  if (templatesReloadCallback) {
    try { templatesReloadCallback(); } catch (err) {
      console.warn("🏪 Templates reload failed:", (err as Error).message);
    }
  }

  console.log("🏪 Store: All items reloaded");
}

// ── Check if hot-reload is available ──────────────

export function isHotReloadAvailable(): {
  skills: boolean;
  mcp: boolean;
  tools: boolean;
} {
  return {
    skills: skillsReloadCallback !== null,
    mcp: mcpConnectCallback !== null,
    tools: toolRegisterCallback !== null,
  };
}
