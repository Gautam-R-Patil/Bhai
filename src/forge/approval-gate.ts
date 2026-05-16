// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Per-channel approval message builder for persisted dynamic tools.
//
// Renders the manifest into a user-readable prompt explaining what the
// synthesized tool will be allowed to do and asking for explicit approval.

import type { PersistedToolManifest } from "./types.js";

export type Channel =
    | "telegram"
    | "whatsapp"
    | "discord"
    | "slack"
    | "matrix"
    | "overlay"
    | "email"
    | "voice"
    | "canvas";

export interface ApprovalRender {
    markdown: string;
    attachmentPaths?: string[];
}

function fmtCapsList(label: string, items: string[]): string {
    if (items.length === 0) return "";
    const bullets = items.map((s) => `  • ${s}`).join("\n");
    return `**${label}:**\n${bullets}\n`;
}

function fmtHandler(handlerCode: string | undefined, channel: Channel): { rendered: string; truncated: boolean } {
    if (!handlerCode) return { rendered: "_(handler code not embedded)_", truncated: false };
    const TG_LIMIT = 3500;
    const code = handlerCode.trim();
    if (channel === "telegram" && code.length > TG_LIMIT) {
        return {
            rendered: "```javascript\n" + code.slice(0, TG_LIMIT) + "\n…(truncated; full code in attachment)…\n```",
            truncated: true,
        };
    }
    return { rendered: "```javascript\n" + code + "\n```", truncated: false };
}

export interface BuildApprovalOpts {
    handlerCode?: string;
}

export function buildApprovalMessage(
    manifest: PersistedToolManifest,
    channel: Channel,
    opts: BuildApprovalOpts = {},
): ApprovalRender {
    const { capabilities: caps } = manifest;
    const capsBlock =
        fmtCapsList("Read access", caps.fs_read) +
        fmtCapsList("Write access", caps.fs_write) +
        fmtCapsList("Network hosts", caps.net) +
        fmtCapsList("Exec commands", caps.exec);

    const totalCaps = caps.fs_read.length + caps.fs_write.length + caps.net.length + caps.exec.length;
    const capsHeader =
        totalCaps === 0
            ? "**No capabilities declared.** This tool will run in a fully-isolated sandbox.\n"
            : capsBlock;

    const handler = fmtHandler(opts.handlerCode, channel);

    const parametersSummary = (() => {
        const props = manifest.parametersSchema?.properties as Record<string, unknown> | undefined;
        if (!props) return "_(no parameters)_";
        const keys = Object.keys(props);
        if (keys.length === 0) return "_(no parameters)_";
        return keys.map((k) => `  • \`${k}\``).join("\n");
    })();

    const md =
        `🔧 **New tool synthesized — awaiting your approval**\n\n` +
        `**Tool:** \`${manifest.slug}\`\n` +
        `**Description:** ${manifest.description}\n` +
        `**Version:** ${manifest.version}\n` +
        `**Handler hash:** \`${manifest.handlerHash}\`\n\n` +
        `**Capabilities requested:**\n${capsHeader}\n` +
        `**Parameters:**\n${parametersSummary}\n\n` +
        `**Handler code:**\n${handler.rendered}\n\n` +
        `To approve, reply with: \`approve_dynamic_tool({slug: "${manifest.slug}", user_quote: "<your verbatim approval text>"})\`\n` +
        `To reject, reply with: \`revoke_dynamic_tool({slug: "${manifest.slug}"})\``;

    return { markdown: md };
}

export function buildRevocationMessage(slug: string, reason: string): string {
    return (
        `🚫 **Tool revoked:** \`${slug}\`\n` +
        `**Reason:** ${reason}\n\n` +
        `The tool has been archived and removed from the active registry. ` +
        `Any pending invocations will return an \`archived\` error.`
    );
}
