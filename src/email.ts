// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Email Channel ─────────────────────────────
// IMAP listener (incoming) + SMTP sender (outgoing)
// Uses Hostinger email: imap.hostinger.com / smtp.hostinger.com

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { LLMClient } from "./llm.js";
import type { Config } from "./config.js";
import { runAgent, type ChannelContext } from "./agent.js";
import { sendOverlayNotification } from "./overlay/overlay-chat.js";

// ── State ─────────────────────────────────────

let imapClient: ImapFlow | null = null;
let smtpTransport: nodemailer.Transporter | null = null;
let emailConfig: Config | null = null;
let llmClient: LLMClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isShuttingDown = false;

// ── Email Authentication Helpers ──────────────

/**
 * Extract a specific header value from raw email source.
 * Handles folded headers (continuation lines starting with whitespace).
 */
function extractHeaderFromSource(rawSource: string, headerName: string): string | null {
    // Headers end at the first blank line
    const headerEndIdx = rawSource.indexOf("\r\n\r\n");
    const headerSection = headerEndIdx > -1 ? rawSource.substring(0, headerEndIdx) : rawSource;

    // Unfold continuation lines (lines starting with whitespace are part of the previous header)
    const unfolded = headerSection.replace(/\r?\n([ \t]+)/g, " ");

    const regex = new RegExp(`^${headerName}:\\s*(.+)$`, "im");
    const match = unfolded.match(regex);
    return match ? match[1].trim() : null;
}

/**
 * Parse email authentication headers (Authentication-Results or ARC-Authentication-Results)
 * to check SPF, DKIM, and DMARC results.
 *
 * Returns whether the email should be considered authenticated.
 * Policy: fail-open. The message is only rejected if ALL three checks explicitly fail.
 * If no authentication header is present, the message is allowed through (with a warning).
 */
export function isEmailAuthenticated(rawSource: string): { authenticated: boolean; details: string } {
    // Try Authentication-Results first, then fall back to ARC-Authentication-Results
    const authHeader =
        extractHeaderFromSource(rawSource, "Authentication-Results") ||
        extractHeaderFromSource(rawSource, "ARC-Authentication-Results");

    if (!authHeader) {
        return {
            authenticated: true,
            details: "No Authentication-Results header found (fail-open: allowed)",
        };
    }

    // Parse individual results — look for spf=, dkim=, dmarc= tokens
    // Results typically look like: "spf=pass", "dkim=pass", "dmarc=fail" etc.
    // Valid result values: pass, fail, softfail, neutral, none, temperror, permerror, policy
    const spfMatch = authHeader.match(/\bspf\s*=\s*(\w+)/i);
    const dkimMatch = authHeader.match(/\bdkim\s*=\s*(\w+)/i);
    const dmarcMatch = authHeader.match(/\bdmarc\s*=\s*(\w+)/i);

    const spfResult = spfMatch ? spfMatch[1].toLowerCase() : "absent";
    const dkimResult = dkimMatch ? dkimMatch[1].toLowerCase() : "absent";
    const dmarcResult = dmarcMatch ? dmarcMatch[1].toLowerCase() : "absent";

    const details = `spf=${spfResult}, dkim=${dkimResult}, dmarc=${dmarcResult}`;

    // Determine which checks explicitly failed
    const failValues = new Set(["fail", "softfail"]);
    const spfFailed = failValues.has(spfResult);
    const dkimFailed = failValues.has(dkimResult);
    const dmarcFailed = failValues.has(dmarcResult);

    // Only reject if ALL three checks are present AND all failed.
    // If any check passes or is absent/neutral/temperror, allow the message.
    if (spfFailed && dkimFailed && dmarcFailed) {
        return {
            authenticated: false,
            details: `All authentication checks failed: ${details}`,
        };
    }

    return {
        authenticated: true,
        details,
    };
}

// ── SMTP Sender ───────────────────────────────

function createSMTPTransport(config: Config): nodemailer.Transporter {
    return nodemailer.createTransport({
        host: config.smtpHost || "smtp.hostinger.com",
        port: config.smtpPort || 465,
        secure: true, // SSL/TLS
        auth: {
            user: config.emailUser!,
            pass: config.emailPassword!,
        },
    });
}

/**
 * Send an email from A.T.L.A.S's own email account.
 * Available as a tool for the agent and internally for email replies.
 */
export async function sendEmailFromAtlas(
    to: string,
    subject: string,
    body: string,
    options?: { cc?: string; bcc?: string; inReplyTo?: string; references?: string },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!smtpTransport || !emailConfig?.emailUser) {
        return { success: false, error: "Email not configured" };
    }

    try {
        const mailOptions: nodemailer.SendMailOptions = {
            from: `A.T.L.A.S <${emailConfig.emailUser}>`,
            to,
            subject,
            text: body,
            html: body.replace(/\n/g, "<br>"),
        };

        if (options?.cc) mailOptions.cc = options.cc;
        if (options?.bcc) mailOptions.bcc = options.bcc;
        if (options?.inReplyTo) mailOptions.inReplyTo = options.inReplyTo;
        if (options?.references) mailOptions.references = options.references;

        const info = await smtpTransport.sendMail(mailOptions);
        console.log(`  📧 Email sent to ${to}: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Email send failed:`, message);
        return { success: false, error: message };
    }
}

// ── IMAP Listener ─────────────────────────────

async function startIMAPListener(config: Config, llm: LLMClient): Promise<void> {
    imapClient = new ImapFlow({
        host: config.imapHost || "imap.hostinger.com",
        port: config.imapPort || 993,
        secure: true,
        auth: {
            user: config.emailUser!,
            pass: config.emailPassword!,
        },
        logger: false, // Suppress verbose IMAP logs
        maxIdleTime: 5 * 60 * 1000, // Re-issue IDLE every 5 minutes
    });

    // Handle connection close — auto-reconnect
    imapClient.on("close", () => {
        if (!isShuttingDown) {
            console.warn("⚠️ [EMAIL] IMAP connection closed, reconnecting in 30s...");
            scheduleReconnect(config, llm);
        }
    });

    imapClient.on("error", (err: Error) => {
        console.error("❌ [EMAIL] IMAP error:", err.message);
        if (!isShuttingDown) {
            scheduleReconnect(config, llm);
        }
    });

    try {
        await imapClient.connect();
        console.log(`✅ Email connected: ${config.emailUser}`);

        // Start listening for new emails (fire-and-forget — this is an infinite polling loop)
        listenForEmails(config, llm).catch(err => {
            console.error("❌ [EMAIL] Listener loop crashed:", (err as Error).message);
            if (!isShuttingDown) scheduleReconnect(config, llm);
        });
    } catch (err) {
        console.error("❌ [EMAIL] IMAP connect failed:", (err as Error).message);
        scheduleReconnect(config, llm);
    }
}

function scheduleReconnect(config: Config, llm: LLMClient): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (isShuttingDown) return;
        console.log("🔄 [EMAIL] Attempting IMAP reconnect...");
        try {
            // Close old client fully before reconnecting
            if (imapClient) {
                try { await imapClient.logout(); } catch { /* ignore */ }
                try { imapClient.close(); } catch { /* ignore */ }
                imapClient = null;
            }
            await startIMAPListener(config, llm);
        } catch (err) {
            console.error("❌ [EMAIL] Reconnect failed:", (err as Error).message);
            scheduleReconnect(config, llm);
        }
    }, 30_000);
}

async function listenForEmails(config: Config, llm: LLMClient): Promise<void> {
    if (!imapClient) return;

    console.log("   📫 Starting email polling loop...");

    // Run forever in a loop: lock → process unseen → release → IDLE → repeat
    while (!isShuttingDown && imapClient) {
        let lock;
        try {
            lock = await imapClient.getMailboxLock("INBOX");
        } catch (err) {
            console.error("❌ [EMAIL] Failed to acquire mailbox lock:", (err as Error).message);
            if (!isShuttingDown) {
                await new Promise(r => setTimeout(r, 10_000));
            }
            continue;
        }

        try {
            await processUnseenEmails(config, llm);
        } catch (err) {
            console.error("❌ [EMAIL] Processing error:", (err as Error).message);
        } finally {
            lock.release();
        }

        // IDLE — wait for new messages (or timeout after 5 min to re-check)
        if (!isShuttingDown && imapClient) {
            try {
                const idleStart = Date.now();
                await imapClient.idle();

                // If IDLE resolved very quickly (e.g., server doesn't support it or returns immediately),
                // ensure we at least wait a minute before looping again to avoid a tight infinite loop.
                const elapsed = Date.now() - idleStart;
                if (!isShuttingDown && elapsed < 60000) {
                    await new Promise(r => setTimeout(r, 60000 - elapsed));
                }
            } catch (err) {
                if (!isShuttingDown) {
                    console.warn("⚠️ [EMAIL] IDLE interrupted:", (err as Error).message);
                    await new Promise(r => setTimeout(r, 60_000));
                }
            }
        }
    }
}

async function processUnseenEmails(config: Config, llm: LLMClient): Promise<void> {
    if (!imapClient) return;

    try {
        // Search for unseen emails — collect all messages first
        // (imapflow doesn't support concurrent commands during fetch iteration)
        console.log("   📬 Checking for unseen emails...");

        interface CollectedEmail {
            uid: number;
            senderEmail: string;
            senderName: string;
            subject: string;
            messageId: string;
            bodyText: string;
            rawSource: string;
        }
        const collected: CollectedEmail[] = [];

        const messages = imapClient.fetch({ seen: false }, {
            envelope: true,
            source: true,
            uid: true,
        });

        for await (const msg of messages) {
            const envelope = msg.envelope;
            if (!envelope) continue;
            const from = envelope.from?.[0];
            const senderEmail = from?.address?.toLowerCase() || "";
            const senderName = from?.name || senderEmail;
            const subject = envelope.subject || "(no subject)";
            const messageId = envelope.messageId || "";

            // Extract body from raw source while in the fetch loop
            const rawSource = msg.source?.toString("utf-8") || "";
            const bodyText = extractTextFromEmail(rawSource);

            collected.push({ uid: msg.uid, senderEmail, senderName, subject, messageId, bodyText, rawSource });
        }

        if (collected.length === 0) {
            console.log("   📭 No unseen emails");
            return;
        }

        console.log(`   📬 Found ${collected.length} unseen email(s), processing...`);

        // Now process each collected email (outside the fetch iterator)
        for (const email of collected) {
            // ── Whitelist check ──
            if (!config.emailWhitelist.has(email.senderEmail)) {
                console.log(`🚫 Blocked email from non-whitelisted sender: ${email.senderEmail}`);
                try {
                    await imapClient!.messageFlagsAdd({ uid: email.uid }, ["\\Seen"], { uid: true });
                } catch { /* ignore */ }
                continue;
            }

            // ── Email authentication check (SPF/DKIM/DMARC) ──
            const authResult = isEmailAuthenticated(email.rawSource);
            if (!authResult.authenticated) {
                console.warn(`⚠️ [EMAIL] Authentication failed for ${email.senderEmail}: ${authResult.details}`);
                console.warn(`🚫 Skipping email from ${email.senderEmail} — possible spoofed sender`);
                try {
                    await imapClient!.messageFlagsAdd({ uid: email.uid }, ["\\Seen"], { uid: true });
                } catch { /* ignore */ }
                continue;
            }
            if (authResult.details.includes("No Authentication-Results")) {
                console.warn(`⚠️ [EMAIL] ${authResult.details} for message from ${email.senderEmail}`);
            } else {
                console.log(`   🔐 Email auth: ${authResult.details}`);
            }

            console.log(`\n📧 Email from ${email.senderName} <${email.senderEmail}>: ${email.subject}`);
            console.log(`   📝 Body preview: ${email.bodyText.substring(0, 100)}...`);

            // Mark as seen
            try {
                await imapClient!.messageFlagsAdd({ uid: email.uid }, ["\\Seen"], { uid: true });
                console.log("   ✅ Marked as seen");
            } catch (err) {
                console.warn("   ⚠️ Failed to mark as seen:", (err as Error).message);
            }

            // Send overlay notification
            sendOverlayNotification(`📧 Email from ${email.senderName}: ${email.subject}`);

            // ── Run through agent ──
            const agentMessage = `[EMAIL from ${email.senderName} <${email.senderEmail}>]\nSubject: ${email.subject}\n\n${email.bodyText}\n\n[SYSTEM NOTE: This message arrived via email. Respond naturally. Your reply will be sent back as an email reply to the sender. Keep the response professional and email-appropriate.]`;

            try {
                console.log("   🤖 Processing email through agent...");
                const progressCallback = async (progressMsg: string) => {
                    console.log(`  📊 [email-progress] ${progressMsg}`);
                };

                const response = await runAgent(llm, agentMessage, progressCallback, undefined, undefined, undefined, undefined, undefined, { channel: "email", userId: email.senderEmail || "", userName: email.senderName, isOwner: true });
                const replyText = response.text;
                console.log(`   🤖 Agent response: ${replyText.substring(0, 200)}...`);

                if (replyText.trim() && replyText.trim() !== "[NO_REPLY]") {
                    // Send reply email
                    const replySubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
                    const result = await sendEmailFromAtlas(email.senderEmail, replySubject, replyText, {
                        inReplyTo: email.messageId,
                        references: email.messageId,
                    });
                    if (result.success) {
                        console.log(`  ✅ Email reply sent to ${email.senderEmail}`);
                    } else {
                        console.error(`  ❌ Email reply failed: ${result.error}`);
                    }
                }
            } catch (err) {
                console.error(`  ❌ Failed to process email from ${email.senderEmail}:`, (err as Error).message);
            }
        }

        console.log(`   📬 Finished processing ${collected.length} email(s)`);
    } catch (err) {
        console.error("❌ [EMAIL] Failed to process unseen emails:", (err as Error).message);
    }
}

/**
 * Basic text extraction from raw email source.
 * Handles both plain text and simple HTML bodies.
 */
function extractTextFromEmail(rawSource: string): string {
    // Try to find plain text part
    // Simple approach: look for Content-Type: text/plain section
    const plainMatch = rawSource.match(
        /Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:[^\r\n]*\r?\n)*?\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\n$)/i,
    );
    if (plainMatch) {
        return decodeEmailText(plainMatch[1].trim());
    }

    // Fallback: try HTML part and strip tags
    const htmlMatch = rawSource.match(
        /Content-Type:\s*text\/html[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:[^\r\n]*\r?\n)*?\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\n$)/i,
    );
    if (htmlMatch) {
        return stripHtmlTags(decodeEmailText(htmlMatch[1].trim()));
    }

    // Last resort: just grab everything after the header block
    const headerEnd = rawSource.indexOf("\r\n\r\n");
    if (headerEnd > -1) {
        const body = rawSource.substring(headerEnd + 4).trim();
        return stripHtmlTags(decodeEmailText(body)).substring(0, 5000);
    }

    return "(could not extract email body)";
}

function decodeEmailText(text: string): string {
    // Handle quoted-printable encoding
    return text
        .replace(/=\r?\n/g, "") // Soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtmlTags(html: string): string {
    // IMPORTANT: Decode HTML entities BEFORE stripping tags to prevent
    // injection via encoded entities like &lt;system&gt;
    let text = html;
    // 1. Decode entities first (while still inside tag context)
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, " ");
    // 2. Convert structural HTML to whitespace
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/p>/gi, "\n\n");
    text = text.replace(/<\/div>/gi, "\n");
    // 3. Strip all remaining HTML tags (including any that were decoded from entities)
    text = text.replace(/<[^>]+>/g, "");
    // 4. Collapse excessive newlines
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
}

// ── Lifecycle ─────────────────────────────────

export async function initEmail(llm: LLMClient, config: Config): Promise<void> {
    if (!config.emailUser || !config.emailPassword) {
        console.log("   📧 Email: not configured (EMAIL_USER / EMAIL_PASSWORD missing)");
        return;
    }

    emailConfig = config;
    llmClient = llm;
    isShuttingDown = false;

    // Create SMTP transport
    smtpTransport = createSMTPTransport(config);

    // Verify SMTP connection
    try {
        await smtpTransport.verify();
        console.log(`   📧 SMTP: connected to ${config.smtpHost || "smtp.hostinger.com"}:${config.smtpPort || 465}`);
    } catch (err) {
        console.warn("⚠️ [EMAIL] SMTP verification failed:", (err as Error).message);
    }

    // Start IMAP listener
    await startIMAPListener(config, llm);
}

export async function closeEmail(): Promise<void> {
    isShuttingDown = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (imapClient) {
        try {
            await imapClient.logout();
        } catch { /* ignore */ }
        imapClient = null;
    }

    if (smtpTransport) {
        smtpTransport.close();
        smtpTransport = null;
    }

    console.log("   📧 Email: closed");
}

export async function testEmailConnection(params: {
    user: string;
    password: string;
    imapHost: string;
    imapPort: number;
}): Promise<{ success: boolean; message: string }> {
    try {
        const { ImapFlow } = await import("imapflow");
        const client = new ImapFlow({
            host: params.imapHost,
            port: params.imapPort,
            secure: true,
            auth: { user: params.user, pass: params.password },
            logger: false,
        });
        await client.connect();
        await client.logout();
        return { success: true, message: "Email connection successful!" };
    } catch (err) {
        return { success: false, message: `Connection failed: ${(err as Error).message}` };
    }
}

export function getEmailStatus(): string {
    if (!imapClient) return "disconnected";
    if (isShuttingDown) return "shutting-down";
    return "connected";
}
