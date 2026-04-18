// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import "dotenv/config";

// ── Types ─────────────────────────────────────

export interface Config {
    telegramBotToken: string;
    allowedUserIds: Set<number>;
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

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`❌ Missing required environment variable: ${name}`);
        console.error(`   → Copy .env.example to .env and fill in your values`);
        process.exit(1);
    }
    return value;
}

function parseUserIds(raw: string): Set<number> {
    const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0);

    if (ids.length === 0) {
        console.error(`❌ ALLOWED_USER_IDS must contain at least one valid Telegram user ID`);
        console.error(`   → Message @userinfobot on Telegram to find your ID`);
        process.exit(1);
    }

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
    const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
    const allowedUserIds = parseUserIds(requireEnv("ALLOWED_USER_IDS"));

    // Email (optional — A.T.L.A.S boots fine without these)
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
        emailUser,
        emailPassword,
        emailWhitelist,
        smtpHost,
        smtpPort,
        imapHost,
        imapPort,
    };
}
