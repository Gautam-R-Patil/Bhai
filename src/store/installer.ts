// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// One-click installer for store items.
// Downloads content, extracts, installs dependencies, and hot-reloads.

import { mkdir, writeFile, rm, readFile, cp } from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "zlib";
import { extract as tarExtract } from "tar";

import type {
  StoreItem,
  StoreItemType,
  InstallProgress,
  ProgressCallback,
  LocalInstallManifest,
  StoreMCPConfig,
} from "./types.js";
import { startInstall, confirmInstall, uninstall as convexUninstall, updateVersion } from "./client.js";
import { buildMcpEnv } from "../mcp/client.js";

// ── Constants ─────────────────────────────────────

const STORE_BASE_PATH = join(homedir(), ".atlas", "store");
const SKILLS_PATH = join(STORE_BASE_PATH, "skills");
const MCP_PATH = join(STORE_BASE_PATH, "mcp-servers");
const TOOLS_PATH = join(STORE_BASE_PATH, "tools");
const DYNAMIC_PATH = join(STORE_BASE_PATH, "dynamic");
const MANIFEST_PATH = join(STORE_BASE_PATH, "installs.json");
const MCP_CONFIG_PATH = join(STORE_BASE_PATH, "mcp-servers.json");
const BACKUP_PATH = join(STORE_BASE_PATH, ".backup");

// ── Get path for item type ────────────────────────

function getItemPath(type: StoreItemType, slug: string): string {
  switch (type) {
    case "skill":
      return join(SKILLS_PATH, slug);
    case "mcp":
      return join(MCP_PATH, slug);
    case "tool":
      return join(TOOLS_PATH, slug);
    case "dynamic":
      return join(DYNAMIC_PATH, slug);
  }
}

// ── Initialize store directories ──────────────────

async function ensureStoreDirectories(): Promise<void> {
  await mkdir(STORE_BASE_PATH, { recursive: true });
  await mkdir(SKILLS_PATH, { recursive: true });
  await mkdir(MCP_PATH, { recursive: true });
  await mkdir(TOOLS_PATH, { recursive: true });
  await mkdir(DYNAMIC_PATH, { recursive: true });
  await mkdir(BACKUP_PATH, { recursive: true });
}

// ── Local manifest operations ─────────────────────

async function loadManifest(): Promise<LocalInstallManifest> {
  try {
    if (existsSync(MANIFEST_PATH)) {
      const content = await readFile(MANIFEST_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors, return fresh manifest
  }
  return { items: {}, lastUpdated: Date.now() };
}

async function saveManifest(manifest: LocalInstallManifest): Promise<void> {
  manifest.lastUpdated = Date.now();
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── MCP config operations ─────────────────────────

async function loadMCPConfig(): Promise<StoreMCPConfig> {
  try {
    if (existsSync(MCP_CONFIG_PATH)) {
      const content = await readFile(MCP_CONFIG_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

async function saveMCPConfig(config: StoreMCPConfig): Promise<void> {
  await writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Download helper ───────────────────────────────

async function downloadFile(url: string, destPath: string): Promise<void> {
  // Enforce HTTPS for security
  if (!url.startsWith("https://")) {
    throw new Error(`Download refused: URL must use HTTPS (got ${url.substring(0, 50)})`);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const fileStream = createWriteStream(destPath);
  const body = response.body;
  if (!body) throw new Error("No response body");

  // Convert ReadableStream to Node stream
  const reader = body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });

  // Readable.fromWeb is the ESM-safe equivalent of the old
  // require("stream").Readable.fromWeb — the project is `"type": "module"`
  // so require is not defined at runtime.
  const nodeStream = Readable.fromWeb(
    stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  await pipeline(nodeStream, fileStream);
}

// ── Extract zip/tar helper ────────────────────────

async function extractArchive(archivePath: string, destPath: string): Promise<void> {
  // Determine archive type from extension or magic bytes
  const content = await readFile(archivePath);

  // Check for tar.gz magic bytes (gzip: 1f 8b)
  if (content[0] === 0x1f && content[1] === 0x8b) {
    // tar.gz
    await tarExtract({
      file: archivePath,
      cwd: destPath,
    });
    return;
  }

  // Check for ZIP magic bytes (50 4b 03 04)
  if (content[0] === 0x50 && content[1] === 0x4b) {
    // macOS/Linux: /usr/bin/unzip
    // Windows: PowerShell Expand-Archive (no unzip in PATH by default)
    if (process.platform === "win32") {
      const psScript = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destPath.replace(/'/g, "''")}' -Force`;
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
          { stdio: "pipe" },
        );
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Expand-Archive exited with code ${code}`));
        });
        proc.on("error", reject);
      });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("unzip", ["-o", archivePath, "-d", destPath], {
        stdio: "pipe",
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`unzip exited with code ${code}`));
      });
      proc.on("error", reject);
    });
    return;
  }

  // Try tar.gz as fallback
  await tarExtract({
    file: archivePath,
    cwd: destPath,
  });
}

// ── npm install helper ────────────────────────────

// npm needs a little more than the MCP allowlist: proxy + npm_config_* settings,
// and on Windows the vars cmd.exe/npm use to find their dirs. Never tokens
// (TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, EMAIL_PASSWORD, ...); npm reads the user's
// own registry auth from ~/.npmrc via HOME.
const NPM_ENV_EXTRAS =
  /^(npm_config_|HTTPS?_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$|SystemRoot$|ComSpec$|PATHEXT$|APPDATA$|LOCALAPPDATA$|USERPROFILE$|TEMP$|TMP$)/i;

// npm config the package must not choose. A package's own .npmrc is npm's
// "project" config and may set any key: git=<a binary it ships>, global=true or
// location=global (install into the global prefix, linking bins that shadow
// commands on PATH). A git dependency is prepared by a nested `npm install` in
// its clone, with that dep's .npmrc and without --ignore-scripts. Env config
// outranks every .npmrc and is inherited by nested npm runs, so pin it here.
const NPM_LOCKDOWN: Record<string, string> = {
  npm_config_ignore_scripts: "true",
  npm_config_allow_git: "none", // npm 11+: no git deps, so no git binary and no nested npm
  npm_config_git: "git", // older npm: git from PATH, never a path the package names
  npm_config_global: "false",
  npm_config_location: "project",
  // cmd.exe (shell: true on Windows) looks for `npm` in the cwd, the package's
  // folder, before PATH; this turns that off.
  NoDefaultCurrentDirectoryInExePath: "1",
};
const PINNED = new Set(Object.keys(NPM_LOCKDOWN).map((k) => k.toLowerCase()));

export function buildNpmInstallEnv(): Record<string, string> {
  const env = buildMcpEnv();
  for (const [k, v] of Object.entries(process.env)) {
    // npm reads npm_config_* case-insensitively: drop any other spelling of a pinned key.
    if (PINNED.has(k.toLowerCase())) continue;
    if (typeof v === "string" && NPM_ENV_EXTRAS.test(k) && !/auth|token|password/i.test(k)) env[k] = v;
  }
  return { ...env, ...NPM_LOCKDOWN };
}

// --ignore-scripts: a store package's (or its deps') install/postinstall hooks
// must not run third-party code at install time. Trade-off: deps that compile
// a native addon in a script (node-gyp, e.g. better-sqlite3) or download a
// binary in postinstall are left unbuilt, so store MCP servers must be pure JS
// or ship prebuilt binaries inside the package. The server itself later runs
// under buildMcpEnv, also without the bot's secrets.
export async function runNpmInstall(dir: string): Promise<void> {
  // The package's .npmrc has no say at all, whatever keys a future npm adds.
  await rm(join(dir, ".npmrc"), { force: true, recursive: true });
  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["install", "--production", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir,
      stdio: "pipe",
      shell: true,
      env: buildNpmInstallEnv(),
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install failed: ${stderr || `exit code ${code}`}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`npm install error: ${err.message}`));
    });
  });
}

// ── Main Install Function ─────────────────────────

/**
 * One-click install — handles everything automatically
 */
export async function installItem(
  item: StoreItem,
  onProgress?: ProgressCallback
): Promise<void> {
  const notify = (stage: InstallProgress["stage"], percent: number, message: string) => {
    onProgress?.({ stage, percent, message });
  };

  try {
    // Ensure directories exist
    await ensureStoreDirectories();

    notify("downloading", 0, "Preparing...");

    // 1. Start install in Convex and get download URL
    const { contentUrl, slug, type, version } = await startInstall(item._id, item.version);

    notify("downloading", 10, "Downloading content...");

    // 2. Download content to temp file
    const tempDir = join(STORE_BASE_PATH, ".temp");
    await mkdir(tempDir, { recursive: true });
    const tempFile = join(tempDir, `${slug}_${Date.now()}`);

    await downloadFile(contentUrl, tempFile);

    notify("downloading", 40, "Download complete");

    // 3. Prepare destination — only created for types that actually extract
    // archive content locally. Skills live server-side and need no dir.
    const destPath = getItemPath(type, slug);

    notify("extracting", 50, "Extracting files...");

    // 4. Extract/copy based on type
    if (type === "skill") {
      // Skill instructions live SERVER-SIDE only — they get assembled into
      // the system prompt by convex/systemContent.ts via the user's
      // store_installs row. We do NOT write the .md content to disk, and
      // we do NOT create a slug-named directory for skills either.
    } else {
      // MCP servers and tools are archives that must be extracted (binary
      // tools that run in-process). These genuinely need local files.
      await mkdir(destPath, { recursive: true });
      await extractArchive(tempFile, destPath);
    }

    // Clean up temp file
    await rm(tempFile, { force: true });

    notify("extracting", 60, "Files extracted");

    // 5. For MCP servers, run npm install
    if (type === "mcp") {
      const packageJson = join(destPath, "package.json");
      if (existsSync(packageJson)) {
        notify("installing_deps", 65, "Installing dependencies...");
        await runNpmInstall(destPath);
        notify("installing_deps", 85, "Dependencies installed");
      }
    }

    notify("configuring", 90, "Configuring...");

    // 6. Update local manifest
    const manifest = await loadManifest();
    manifest.items[slug] = {
      itemId: item._id,
      type,
      name: item.name,
      version,
      installedAt: Date.now(),
      autoUpdate: true,
      // Skills are server-only; record a virtual path for UI display.
      path: type === "skill" ? `server://store_installs/${slug}` : destPath,
    };
    await saveManifest(manifest);

    // 7. For MCP servers, add to MCP config
    if (type === "mcp") {
      await addToMCPConfig(slug, destPath);
    }

    // 8. Confirm install complete in Convex
    await confirmInstall(item._id);

    notify("done", 100, "Installed!");

    console.log(`🏪 Store: Installed ${item.name} v${version}`);
  } catch (err) {
    console.error(`🏪 Store: Install failed for ${item.name}:`, (err as Error).message);
    onProgress?.({ stage: "error", percent: 0, message: (err as Error).message });
    throw err;
  }
}

// ── Add MCP server to config ──────────────────────

async function addToMCPConfig(slug: string, installPath: string): Promise<void> {
  const config = await loadMCPConfig();

  // Read the atlas.config.json from the installed package
  const configPath = join(installPath, "atlas.config.json");
  let mcpConfig = {
    command: "node",
    args: [join(installPath, "dist", "index.js")],
  };

  if (existsSync(configPath)) {
    const atlasConfig = JSON.parse(await readFile(configPath, "utf-8"));
    if (atlasConfig.mcp) {
      mcpConfig = {
        command: atlasConfig.mcp.command || "node",
        args: (atlasConfig.mcp.args || ["dist/index.js"]).map((arg: string) =>
          arg.startsWith("/") ? arg : join(installPath, arg)
        ),
        ...(atlasConfig.mcp.env ? { env: atlasConfig.mcp.env } : {}),
      };
    }
  }

  config[`store_${slug}`] = mcpConfig as StoreMCPConfig[string];
  await saveMCPConfig(config);
}

// ── Remove MCP server from config ─────────────────

async function removeFromMCPConfig(slug: string): Promise<void> {
  const config = await loadMCPConfig();
  delete config[`store_${slug}`];
  await saveMCPConfig(config);
}

// ── Uninstall Function ────────────────────────────

/**
 * One-click uninstall
 */
export async function uninstallItem(item: StoreItem): Promise<void> {
  const { slug, type } = item;

  console.log(`🏪 Store: Uninstalling ${item.name}...`);

  // 1. Remove files
  const itemPath = getItemPath(type, slug);
  if (existsSync(itemPath)) {
    await rm(itemPath, { recursive: true, force: true });
  }

  // 2. Update local manifest
  const manifest = await loadManifest();
  delete manifest.items[slug];
  await saveManifest(manifest);

  // 3. For MCP servers, remove from config
  if (type === "mcp") {
    await removeFromMCPConfig(slug);
  }

  // 4. Record uninstall in Convex
  await convexUninstall(item._id);

  console.log(`🏪 Store: Uninstalled ${item.name}`);
}

// ── Update Function ───────────────────────────────

/**
 * One-click update
 */
export async function updateItem(
  item: StoreItem,
  onProgress?: ProgressCallback
): Promise<void> {
  const { slug, type } = item;

  const notify = (stage: InstallProgress["stage"], percent: number, message: string) => {
    onProgress?.({ stage, percent, message });
  };

  notify("downloading", 0, "Preparing update...");

  // 1. Backup current version
  const itemPath = getItemPath(type, slug);
  const backupPath = join(BACKUP_PATH, slug);

  if (existsSync(itemPath)) {
    await rm(backupPath, { recursive: true, force: true });
    // fs.cp (Node 16.7+) replaces the Unix-only `cp -r` spawn.
    await cp(itemPath, backupPath, { recursive: true, force: true });
  }

  try {
    // 2. Re-install (this will overwrite)
    await installItem(item, (progress) => {
      // Adjust progress to account for backup phase
      const adjustedPercent = 10 + progress.percent * 0.85;
      notify(progress.stage, adjustedPercent, progress.message);
    });

    // 3. Update version in Convex
    await updateVersion(item._id, item.version);

    // 4. Cleanup backup
    await rm(backupPath, { recursive: true, force: true });

    notify("done", 100, "Updated!");
    console.log(`🏪 Store: Updated ${item.name} to v${item.version}`);
  } catch (err) {
    // Restore from backup — fs.cp works on all platforms.
    if (existsSync(backupPath)) {
      await rm(itemPath, { recursive: true, force: true });
      await cp(backupPath, itemPath, { recursive: true, force: true });
      await rm(backupPath, { recursive: true, force: true });
    }

    throw err;
  }
}

// ── Get installed items ───────────────────────────

/**
 * Get all locally installed items from manifest
 */
export async function getLocalInstalls(): Promise<LocalInstallManifest["items"]> {
  const manifest = await loadManifest();
  return manifest.items;
}

/**
 * Check if item is installed locally
 */
export async function isInstalledLocally(slug: string): Promise<boolean> {
  const manifest = await loadManifest();
  return slug in manifest.items;
}

/**
 * Get local install info
 */
export async function getLocalInstallInfo(
  slug: string
): Promise<LocalInstallManifest["items"][string] | null> {
  const manifest = await loadManifest();
  return manifest.items[slug] || null;
}

// ── Exports for external use ──────────────────────

export { STORE_BASE_PATH, SKILLS_PATH, MCP_PATH, TOOLS_PATH, DYNAMIC_PATH, MCP_CONFIG_PATH };
