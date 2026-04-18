// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { sendEmailFromAtlas } from "../email.js";

// ── email_send ────────────────────────────────

export const emailSend: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "email_send",
            description:
                "Send an email from A.T.L.A.S's email account (ai@codingdesk.info). " +
                "Use this for sending emails, reports, notifications, or any email communication. " +
                "If the user wants to send from THEIR OWN email, use the browser tools to open their webmail instead.",
            parameters: {
                type: "object",
                properties: {
                    to: {
                        type: "string",
                        description: "Recipient email address (or comma-separated for multiple recipients)",
                    },
                    subject: {
                        type: "string",
                        description: "Email subject line",
                    },
                    body: {
                        type: "string",
                        description: "Email body content. Can include plain text or basic HTML formatting.",
                    },
                    cc: {
                        type: "string",
                        description: "Optional: CC recipient(s), comma-separated",
                    },
                    bcc: {
                        type: "string",
                        description: "Optional: BCC recipient(s), comma-separated",
                    },
                },
                required: ["to", "subject", "body"],
            },
        },
    },

    async handler(input) {
        const to = input.to as string;
        const subject = input.subject as string;
        const body = input.body as string;
        const cc = input.cc as string | undefined;
        const bcc = input.bcc as string | undefined;

        if (!to || !subject) {
            return JSON.stringify({ error: "Missing required fields: 'to' and 'subject'" });
        }

        const result = await sendEmailFromAtlas(to, subject, body, { cc, bcc });
        return JSON.stringify(result, null, 2);
    },
};
