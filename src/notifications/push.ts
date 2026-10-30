// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// -- Push Notifications -----------------------------------
// VAPID-based web push notifications using the web-push library.
// Generates and persists VAPID keys on first run, stores subscriptions
// in memory, and provides sendPushNotification() for the proactive system.

import { createECDH } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../config/paths.js";

// -- Types ------------------------------------------------

interface StoredVapidKeys {
    publicKey: string;
    privateKey: string;
}

interface PushSubscriptionData {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
}

// -- State ------------------------------------------------

const VAPID_PATH = join(getDataDir(), "vapid-keys.json");
const SUBSCRIPTIONS_PATH = join(getDataDir(), "push-subscriptions.json");

let vapidKeys: StoredVapidKeys | null = null;
const subscriptions: Map<string, PushSubscriptionData> = new Map();
let initialized = false;

// The part of web-push used here (it ships no type declarations).
interface WebPush {
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(
        sub: { endpoint: string; keys: PushSubscriptionData["keys"] },
        payload: string,
        opts: { TTL: number },
    ): Promise<unknown>;
}
let webPushMod: Promise<WebPush> | null = null;
/** web-push loads on first send, not at boot. */
function loadWebPush(): Promise<WebPush> {
    // @ts-expect-error -- web-push has no type declarations
    webPushMod ??= import("web-push").then((m: { default: WebPush }) => m.default);
    return webPushMod;
}

// -- Initialize -------------------------------------------

/**
 * Generate or load VAPID keys from data/vapid-keys.json.
 * Must be called before any push operations.
 */
export async function initPushNotifications(): Promise<void> {
    // Ensure data directory exists
    const dataDir = dirname(VAPID_PATH);
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    // Load or generate VAPID keys
    if (existsSync(VAPID_PATH)) {
        try {
            const raw = readFileSync(VAPID_PATH, "utf-8");
            vapidKeys = JSON.parse(raw) as StoredVapidKeys;
            console.log("[PUSH] Loaded existing VAPID keys");
        } catch (err) {
            console.warn("[PUSH] Failed to load VAPID keys, regenerating:", (err as Error).message);
            vapidKeys = null;
        }
    }

    if (!vapidKeys) {
        // Same as web-push's generateVAPIDKeys(), synchronously, so the public
        // key is ready on first boot without loading web-push.
        const curve = createECDH("prime256v1");
        curve.generateKeys();
        const pad = (b: Buffer, n: number) => (b.length < n ? Buffer.concat([Buffer.alloc(n - b.length), b]) : b);
        vapidKeys = {
            publicKey: pad(curve.getPublicKey(), 65).toString("base64url"),
            privateKey: pad(curve.getPrivateKey(), 32).toString("base64url"),
        };
        try {
            writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2), "utf-8");
            console.log("[PUSH] Generated and saved new VAPID keys");
        } catch (err) {
            console.warn("[PUSH] Failed to persist VAPID keys:", (err as Error).message);
        }
    }

    // Load persisted subscriptions
    if (existsSync(SUBSCRIPTIONS_PATH)) {
        try {
            const raw = readFileSync(SUBSCRIPTIONS_PATH, "utf-8");
            const stored = JSON.parse(raw) as PushSubscriptionData[];
            for (const sub of stored) {
                subscriptions.set(sub.endpoint, sub);
            }
            console.log(`[PUSH] Loaded ${subscriptions.size} stored subscription(s)`);
        } catch {
            // Corrupted file -- start fresh
        }
    }

    initialized = true;
    console.log("[PUSH] Push notifications initialized");
}

// -- Public Key -------------------------------------------

/**
 * Returns the VAPID public key for client-side subscription registration.
 */
export function getVapidPublicKey(): string | null {
    return vapidKeys?.publicKey ?? null;
}

// -- Register Subscription --------------------------------

/**
 * Store a push subscription received from the client.
 * Deduplicates by endpoint URL.
 */
export function registerSubscription(subscription: PushSubscriptionData): void {
    subscriptions.set(subscription.endpoint, subscription);
    persistSubscriptions();
    console.log(`[PUSH] Registered subscription (${subscriptions.size} total)`);
}

/**
 * Remove a subscription by endpoint.
 */
export function removeSubscription(endpoint: string): void {
    subscriptions.delete(endpoint);
    persistSubscriptions();
}

function persistSubscriptions(): void {
    try {
        const data = [...subscriptions.values()];
        writeFileSync(SUBSCRIPTIONS_PATH, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
        console.warn("[PUSH] Failed to persist subscriptions:", (err as Error).message);
    }
}

// -- Send Notification ------------------------------------

/**
 * Send a push notification to all registered subscriptions.
 * Automatically removes expired/invalid subscriptions.
 */
export async function sendPushNotification(
    title: string,
    body: string,
    url?: string,
): Promise<{ sent: number; failed: number }> {
    if (!initialized || subscriptions.size === 0) {
        return { sent: 0, failed: 0 };
    }

    const keys = vapidKeys;
    if (!keys) return { sent: 0, failed: 0 };
    let webPush: WebPush;
    try {
        webPush = await loadWebPush();
        // Configure web-push with VAPID details
        const contactEmail = process.env.EMAIL_USER || "atlas@localhost";
        webPush.setVapidDetails(`mailto:${contactEmail}`, keys.publicKey, keys.privateKey);
    } catch (err) {
        console.warn("[PUSH] web-push setup failed:", (err as Error).message);
        return { sent: 0, failed: 0 };
    }

    const payload = JSON.stringify({
        title,
        body: body.length > 200 ? body.substring(0, 197) + "..." : body,
        url: url || "/",
        icon: "/atlas-icon.png",
        badge: "/atlas-badge.png",
        timestamp: Date.now(),
    });

    let sent = 0;
    let failed = 0;
    const expiredEndpoints: string[] = [];

    const promises = [...subscriptions.entries()].map(async ([endpoint, sub]) => {
        try {
            await webPush.sendNotification(
                {
                    endpoint: sub.endpoint,
                    keys: sub.keys,
                },
                payload,
                { TTL: 3600 }, // 1 hour TTL
            );
            sent++;
        } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode;
            // 404 or 410 = subscription expired/unsubscribed
            if (statusCode === 404 || statusCode === 410) {
                expiredEndpoints.push(endpoint);
            }
            failed++;
            console.warn(`[PUSH] Failed to send to ${endpoint.substring(0, 60)}...: ${(err as Error).message}`);
        }
    });

    await Promise.allSettled(promises);

    // Clean up expired subscriptions
    if (expiredEndpoints.length > 0) {
        for (const ep of expiredEndpoints) {
            subscriptions.delete(ep);
        }
        persistSubscriptions();
        console.log(`[PUSH] Removed ${expiredEndpoints.length} expired subscription(s)`);
    }

    if (sent > 0) {
        console.log(`[PUSH] Sent ${sent} notification(s), ${failed} failed`);
    }

    return { sent, failed };
}

/**
 * Returns the number of active subscriptions.
 */
export function getSubscriptionCount(): number {
    return subscriptions.size;
}
