// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// GitMCP Bridge — Creates instant MCP servers for any GitHub repo on-the-fly.
// Based on GitMCP (7.9K stars). Zero setup — AI gets access to up-to-date docs.

export interface GitMCPServer {
    repoUrl: string;
    mcpEndpoint: string;
    capabilities: string[];
    status: "active" | "error";
}

const activeServers = new Map<string, GitMCPServer>();
const MAX_ACTIVE_SERVERS = 50;

// owner / repo names per GitHub policy: alphanumerics + `._-`, 1-39 chars.
// Must contain at least one alphanumeric so "..." / "---" can't pass.
const SLUG_RE = /^(?=[A-Za-z0-9._-]{1,39}$)[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function getGitMCPEndpoint(repoUrl: string): string {
    // Strict URL parse so attacker-supplied strings like
    // "evil.com/foo/bar/?github.com/owner/repo" can't masquerade as a
    // github.com URL via substring matching.
    let url: URL;
    try {
        url = new URL(repoUrl);
    } catch {
        return "";
    }
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return "";
    // Pathname is `/owner/repo[/...]`. Reject anything else.
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    const [owner, repo] = parts;
    const cleanRepo = repo.replace(/\.git$/, "");
    if (!SLUG_RE.test(owner) || !SLUG_RE.test(cleanRepo)) return "";
    return `https://${owner}.${cleanRepo}.gitmcp.io`;
}

export async function connectGitMCPServer(repoUrl: string): Promise<GitMCPServer | null> {
    const endpoint = getGitMCPEndpoint(repoUrl);
    if (!endpoint) return null;

    if (activeServers.has(repoUrl)) return activeServers.get(repoUrl)!;
    if (activeServers.size >= MAX_ACTIVE_SERVERS) return null;

    try {
        const resp = await fetch(endpoint, { method: "HEAD", signal: AbortSignal.timeout(5000) });
        const server: GitMCPServer = {
            repoUrl, mcpEndpoint: endpoint,
            capabilities: ["read_documentation", "search_code", "list_files"],
            status: resp.ok ? "active" : "error",
        };
        if (server.status === "active") activeServers.set(repoUrl, server);
        return server;
    } catch {
        return { repoUrl, mcpEndpoint: endpoint, capabilities: [], status: "error" };
    }
}

export function getActiveGitMCPServers(): GitMCPServer[] { return [...activeServers.values()]; }
