// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { sendBhaiMail } from "../bhai-mail.js";
import { sendEmailFromBhai } from "../email.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── email_send ────────────────────────────────

export const emailSend: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "email_send",
            description:
                "Send an email from Bhai's own email address. " +
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

        // No mailbox of the owner's connected but Bhai has its own address: send from that.
        if (!process.env.EMAIL_USER && process.env.BHAI_MAIL_ADDRESS) {
            if (bcc) return JSON.stringify({ error: "Bhai's own email can't BCC; put them in cc or send separately." });
            return JSON.stringify(await sendBhaiMail({ to, cc, subject, text: body }), null, 2);
        }
        const result = await sendEmailFromBhai(to, subject, body, { cc, bcc });
        return JSON.stringify(result, null, 2);
    },
};
