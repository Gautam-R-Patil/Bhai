// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── GitHub API Integration ────────────────────
// Creates issues, checks PRs, lists repos, and triggers workflows.
// Uses GitHub REST API with a Personal Access Token (PAT).

import type { ToolDefinition } from "./get-current-time.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_API = "https://api.github.com";

async function githubFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "bhai-agent",
        ...((options.headers as Record<string, string>) || {}),
    };
    if (GITHUB_TOKEN) {
        headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
    }

    const response = await fetch(`${GITHUB_API}${endpoint}`, {
        ...options,
        headers,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub API ${response.status}: ${text.substring(0, 200)}`);
    }

    return response.json();
}

export const githubTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "github",
            description:
                "Interact with GitHub: list repos, create issues, check PRs, view notifications. Requires GITHUB_TOKEN env var.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: [
                            "repos",
                            "issues",
                            "create_issue",
                            "prs",
                            "pr_detail",
                            "notifications",
                            "runs",
                            "run_detail",
                            "check_status",
                            "graphql",
                        ],
                        description: "Action to perform",
                    },
                    owner: { type: "string", description: "Repo owner (username or org)" },
                    repo: { type: "string", description: "Repository name" },
                    title: { type: "string", description: "Issue title (for 'create_issue')" },
                    body: { type: "string", description: "Issue/PR body text" },
                    labels: {
                        type: "array",
                        items: { type: "string" },
                        description: "Labels for the issue",
                    },
                    pr_number: { type: "number", description: "PR number (for 'pr_detail' or 'check_status')" },
                    run_id: { type: "number", description: "Workflow run ID (for 'run_detail')" },
                    query: { type: "string", description: "GraphQL query string (for 'graphql')" },
                    variables: { type: "object", description: "GraphQL variables (for 'graphql')" },
                    state: {
                        type: "string",
                        enum: ["open", "closed", "all"],
                        description: "Filter by state (default: open)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        if (!GITHUB_TOKEN) {
            return JSON.stringify({
                error: "GITHUB_TOKEN not set. Add it to your .env file to use GitHub features.",
            });
        }

        try {
            if (action === "repos") {
                const data = (await githubFetch("/user/repos?sort=updated&per_page=20")) as Array<{
                    full_name: string;
                    description: string;
                    language: string;
                    stargazers_count: number;
                    open_issues_count: number;
                    updated_at: string;
                    private: boolean;
                }>;
                return JSON.stringify({
                    success: true,
                    count: data.length,
                    repos: data.map((r) => ({
                        name: r.full_name,
                        description: r.description || "",
                        language: r.language,
                        stars: r.stargazers_count,
                        issues: r.open_issues_count,
                        updated: r.updated_at,
                        private: r.private,
                    })),
                });
            }

            if (action === "issues") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                if (!owner || !repo) return JSON.stringify({ error: "Provide 'owner' and 'repo'." });
                const state = (input.state as string) || "open";

                const data = (await githubFetch(`/repos/${owner}/${repo}/issues?state=${state}&per_page=15`)) as Array<{
                    number: number;
                    title: string;
                    state: string;
                    user: { login: string };
                    labels: Array<{ name: string }>;
                    created_at: string;
                    comments: number;
                }>;
                return JSON.stringify({
                    success: true,
                    count: data.length,
                    issues: data.map((i) => ({
                        number: i.number,
                        title: i.title,
                        state: i.state,
                        author: i.user.login,
                        labels: i.labels.map((l) => l.name),
                        created: i.created_at,
                        comments: i.comments,
                    })),
                });
            }

            if (action === "create_issue") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                const title = input.title as string;
                if (!owner || !repo || !title)
                    return JSON.stringify({ error: "Provide 'owner', 'repo', and 'title'." });

                const data = (await githubFetch(`/repos/${owner}/${repo}/issues`, {
                    method: "POST",
                    body: JSON.stringify({
                        title,
                        body: input.body || "",
                        labels: input.labels || [],
                    }),
                })) as { number: number; html_url: string; title: string };

                return JSON.stringify({
                    success: true,
                    issue: { number: data.number, url: data.html_url, title: data.title },
                });
            }

            if (action === "prs") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                if (!owner || !repo) return JSON.stringify({ error: "Provide 'owner' and 'repo'." });
                const state = (input.state as string) || "open";

                const data = (await githubFetch(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=15`)) as Array<{
                    number: number;
                    title: string;
                    state: string;
                    user: { login: string };
                    created_at: string;
                    head: { ref: string };
                    base: { ref: string };
                    draft: boolean;
                }>;
                return JSON.stringify({
                    success: true,
                    count: data.length,
                    prs: data.map((p) => ({
                        number: p.number,
                        title: p.title,
                        state: p.state,
                        author: p.user.login,
                        from: p.head.ref,
                        to: p.base.ref,
                        draft: p.draft,
                        created: p.created_at,
                    })),
                });
            }

            if (action === "pr_detail") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                const prNumber = input.pr_number as number;
                if (!owner || !repo || !prNumber)
                    return JSON.stringify({ error: "Provide 'owner', 'repo', and 'pr_number'." });

                const [pr, reviews] = await Promise.all([
                    githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`) as Promise<{
                        title: string;
                        state: string;
                        body: string;
                        mergeable: boolean;
                        additions: number;
                        deletions: number;
                        changed_files: number;
                        user: { login: string };
                        merged: boolean;
                    }>,
                    githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`) as Promise<
                        Array<{
                            user: { login: string };
                            state: string;
                            submitted_at: string;
                        }>
                    >,
                ]);

                return JSON.stringify({
                    success: true,
                    pr: {
                        title: pr.title,
                        state: pr.state,
                        author: pr.user.login,
                        body: (pr.body || "").substring(0, 500),
                        mergeable: pr.mergeable,
                        merged: pr.merged,
                        additions: pr.additions,
                        deletions: pr.deletions,
                        files_changed: pr.changed_files,
                        reviews: reviews.map((r) => ({
                            reviewer: r.user.login,
                            state: r.state,
                            date: r.submitted_at,
                        })),
                    },
                });
            }

            if (action === "notifications") {
                const data = (await githubFetch("/notifications?per_page=20")) as Array<{
                    subject: { title: string; type: string; url: string };
                    repository: { full_name: string };
                    reason: string;
                    updated_at: string;
                    unread: boolean;
                }>;
                return JSON.stringify({
                    success: true,
                    count: data.length,
                    notifications: data.map((n) => ({
                        title: n.subject.title,
                        type: n.subject.type,
                        repo: n.repository.full_name,
                        reason: n.reason,
                        updated: n.updated_at,
                        unread: n.unread,
                    })),
                });
            }

            if (action === "runs") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                if (!owner || !repo) return JSON.stringify({ error: "Provide 'owner' and 'repo'." });

                const data = (await githubFetch(`/repos/${owner}/${repo}/actions/runs?per_page=10`)) as {
                    workflow_runs: Array<{
                        id: number;
                        name: string;
                        status: string;
                        conclusion: string | null;
                        html_url: string;
                        head_branch: string;
                        event: string;
                        created_at: string;
                        updated_at: string;
                        actor: { login: string };
                    }>;
                };
                return JSON.stringify({
                    success: true,
                    count: data.workflow_runs.length,
                    runs: data.workflow_runs.map((r) => ({
                        id: r.id,
                        name: r.name,
                        status: r.status,
                        conclusion: r.conclusion,
                        branch: r.head_branch,
                        event: r.event,
                        actor: r.actor.login,
                        url: r.html_url,
                        created: r.created_at,
                    })),
                });
            }

            if (action === "run_detail") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                const runId = input.run_id as number;
                if (!owner || !repo || !runId)
                    return JSON.stringify({ error: "Provide 'owner', 'repo', and 'run_id'." });

                const [run, jobs] = await Promise.all([
                    githubFetch(`/repos/${owner}/${repo}/actions/runs/${runId}`) as Promise<{
                        id: number;
                        name: string;
                        status: string;
                        conclusion: string | null;
                        html_url: string;
                        head_branch: string;
                        run_started_at: string;
                    }>,
                    githubFetch(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`) as Promise<{
                        jobs: Array<{
                            id: number;
                            name: string;
                            status: string;
                            conclusion: string | null;
                            started_at: string;
                            completed_at: string | null;
                            steps?: Array<{ name: string; status: string; conclusion: string | null }>;
                        }>;
                    }>,
                ]);

                return JSON.stringify({
                    success: true,
                    run: {
                        id: run.id,
                        name: run.name,
                        status: run.status,
                        conclusion: run.conclusion,
                        branch: run.head_branch,
                        url: run.html_url,
                        started: run.run_started_at,
                        jobs: jobs.jobs.map((j) => ({
                            name: j.name,
                            status: j.status,
                            conclusion: j.conclusion,
                            started: j.started_at,
                            completed: j.completed_at,
                            steps: (j.steps || []).map((s) => ({
                                name: s.name,
                                status: s.status,
                                conclusion: s.conclusion,
                            })),
                        })),
                    },
                });
            }

            if (action === "check_status") {
                const owner = input.owner as string;
                const repo = input.repo as string;
                const prNumber = input.pr_number as number;
                if (!owner || !repo || !prNumber)
                    return JSON.stringify({ error: "Provide 'owner', 'repo', and 'pr_number'." });

                const [checks, statuses] = await Promise.all([
                    githubFetch(
                        `/repos/${owner}/${repo}/commits/refs/pull/${prNumber}/head/check-runs?per_page=30`,
                    ).catch(() => ({ check_runs: [] })) as Promise<{
                        check_runs: Array<{
                            name: string;
                            status: string;
                            conclusion: string | null;
                            html_url: string;
                        }>;
                    }>,
                    githubFetch(`/repos/${owner}/${repo}/commits/refs/pull/${prNumber}/head/status`).catch(() => ({
                        statuses: [],
                    })) as Promise<{
                        statuses: Array<{ context: string; state: string; target_url: string }>;
                    }>,
                ]);

                return JSON.stringify({
                    success: true,
                    pr_number: prNumber,
                    checks: (checks.check_runs || []).map((c) => ({
                        name: c.name,
                        status: c.status,
                        conclusion: c.conclusion,
                        url: c.html_url,
                    })),
                    statuses: (statuses.statuses || []).map((s) => ({
                        context: s.context,
                        state: s.state,
                        url: s.target_url,
                    })),
                });
            }

            if (action === "graphql") {
                const query = input.query as string;
                if (!query) return JSON.stringify({ error: "Provide 'query' for GraphQL." });

                const response = await fetch("https://api.github.com/graphql", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${GITHUB_TOKEN}`,
                        "Content-Type": "application/json",
                        "User-Agent": "bhai-agent",
                    },
                    body: JSON.stringify({
                        query,
                        variables: input.variables || {},
                    }),
                });

                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`GitHub GraphQL ${response.status}: ${text.substring(0, 200)}`);
                }

                const data = await response.json();
                return JSON.stringify({ success: true, data });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
