// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import {
    getGitMCPEndpoint,
    connectGitMCPServer,
} from "../mcp/gitmcp-bridge.js";

export const gitmcpDocs: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "gitmcp_docs",
            description:
                "Resolve a GitHub repository URL to its GitMCP endpoint and verify it responds. Lets the agent obtain zero-setup MCP-backed access to any GitHub repo's documentation and code. Returns the endpoint URL, reachability status, and declared capabilities.",
            parameters: {
                type: "object",
                properties: {
                    repoUrl: {
                        type: "string",
                        description:
                            "Full GitHub repository URL (e.g. 'https://github.com/anthropics/claude-code').",
                    },
                    probe: {
                        type: "boolean",
                        description:
                            "When true (default), also issues a HEAD request to the endpoint to confirm reachability. Set false to skip the network check.",
                    },
                },
                required: ["repoUrl"],
            },
        },
    },

    async handler(input) {
        const repoUrl = String(input.repoUrl ?? "").trim();
        if (!repoUrl) {
            return JSON.stringify({
                error: "repoUrl is required",
            });
        }
        const probe = input.probe !== false;
        const endpoint = getGitMCPEndpoint(repoUrl);
        if (!endpoint) {
            return JSON.stringify({
                error: "repoUrl must be a github.com URL",
                input: repoUrl,
            });
        }
        if (!probe) {
            return JSON.stringify({ repoUrl, endpoint, status: "resolved" });
        }
        const server = await connectGitMCPServer(repoUrl);
        if (!server) {
            return JSON.stringify({
                error: "Could not resolve GitMCP endpoint",
                repoUrl,
                endpoint,
            });
        }
        return JSON.stringify({
            repoUrl: server.repoUrl,
            endpoint: server.mcpEndpoint,
            status: server.status,
            capabilities: server.capabilities,
        });
    },
};
