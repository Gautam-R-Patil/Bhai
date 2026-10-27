// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import "dotenv/config";

// ── Types ─────────────────────────────────────

export interface Config {
    /** Empty string when Telegram is not configured. Check `telegramEnabled` before use. */
    telegramBotToken: string;
    /** Always a Set; empty when Telegram is not configured. */
    allowedUserIds: Set<number>;
    /** True only when both TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS are present and valid. */
    telegramEnabled: boolean;
    // Email (optional)
    emailUser?: string;
    emailPassword?: string;
    emailWhitelist: Set<string>;
    smtpHost?: string;
    smtpPort?: number;
    imapHost?: string;
    imapPort?: number;
}

// ── Helpers ───────────────────────────────────

function parseUserIds(raw: string): Set<number> {
    const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0);
    return new Set(ids);
}

function parseEmailWhitelist(raw?: string): Set<string> {
    if (!raw) return new Set();
    return new Set(
        raw.split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
    );
}

// ── Load Config ───────────────────────────────

export function loadConfig(): Config {
    // Telegram is optional — Bhai boots without it (other channels: overlay,
    // desktop, WhatsApp, Discord, Slack, Matrix, email). Both env vars must be
    // present AND valid for Telegram to be enabled; partial config (token without
    // user IDs, or vice versa) is treated as "not configured" with a warning.
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
    const rawUserIds = process.env.ALLOWED_USER_IDS || "";
    const allowedUserIds = rawUserIds ? parseUserIds(rawUserIds) : new Set<number>();
    const telegramEnabled = telegramBotToken.length > 0 && allowedUserIds.size > 0;

    if (telegramBotToken && allowedUserIds.size === 0) {
        console.warn("⚠️  TELEGRAM_BOT_TOKEN is set but ALLOWED_USER_IDS is empty — Telegram channel disabled.");
    } else if (!telegramBotToken && rawUserIds) {
        console.warn("⚠️  ALLOWED_USER_IDS is set but TELEGRAM_BOT_TOKEN is missing — Telegram channel disabled.");
    } else if (!telegramEnabled) {
        console.log("ℹ️  Telegram channel not configured — running with other channels.");
    }

    // Email (optional — Bhai boots fine without these)
    const emailUser = process.env.EMAIL_USER || undefined;
    const emailPassword = process.env.EMAIL_PASSWORD || undefined;
    const emailWhitelist = parseEmailWhitelist(process.env.EMAIL_WHITELIST);
    const smtpHost = process.env.EMAIL_SMTP_HOST || undefined;
    const smtpPort = process.env.EMAIL_SMTP_PORT ? parseInt(process.env.EMAIL_SMTP_PORT, 10) : undefined;
    const imapHost = process.env.EMAIL_IMAP_HOST || undefined;
    const imapPort = process.env.EMAIL_IMAP_PORT ? parseInt(process.env.EMAIL_IMAP_PORT, 10) : undefined;

    return {
        telegramBotToken,
        allowedUserIds,
        telegramEnabled,
        emailUser,
        emailPassword,
        emailWhitelist,
        smtpHost,
        smtpPort,
        imapHost,
        imapPort,
    };
}
