// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// GitMCP Bridge — Creates instant MCP servers for any GitHub repo on-the-fly.
// Based on GitMCP (7.9K stars). Zero setup — AI gets access to up-to-date docs.

export interface GitMCPServer {
    repoUrl: string;
    mcpEndpoint: string;
    capabilities: string[];
    status: "active" | "error";
}

const activeServers = new Map<string, GitMCPServer>();

export function getGitMCPEndpoint(repoUrl: string): string {
    // GitMCP converts GitHub URLs to MCP endpoints
    // github.com/owner/repo → owner.repo.gitmcp.io
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return "";
    return `https://${match[1]}.${match[2]}.gitmcp.io`;
}

export async function connectGitMCPServer(repoUrl: string): Promise<GitMCPServer | null> {
    const endpoint = getGitMCPEndpoint(repoUrl);
    if (!endpoint) return null;

    if (activeServers.has(repoUrl)) return activeServers.get(repoUrl)!;

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
