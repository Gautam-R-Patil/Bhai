// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Encrypted Secrets ─────────────────────────
// AES-256-GCM encryption at rest

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Constants ─────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SECRETS_FILE = path.resolve("data", "secrets.enc");

// ── Derive Key ────────────────────────────────

function deriveKey(masterKey: string): Buffer {
    return crypto.scryptSync(masterKey, "atlas-salt", KEY_LENGTH);
}

// ── Encrypt ───────────────────────────────────

export function encrypt(plaintext: string, masterKey: string): string {
    const key = deriveKey(masterKey);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();

    // Format: iv:tag:ciphertext
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

// ── Decrypt ───────────────────────────────────

export function decrypt(encrypted: string, masterKey: string): string {
    const key = deriveKey(masterKey);
    const [ivHex, tagHex, ciphertext] = encrypted.split(":");

    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
}

// ── Secret Store ──────────────────────────────

interface SecretStore {
    [key: string]: string; // encrypted values
}

export function storeSecret(name: string, value: string, masterKey: string): void {
    const store = loadStore();
    store[name] = encrypt(value, masterKey);
    saveStore(store);
}

export function getSecret(name: string, masterKey: string): string | null {
    const store = loadStore();
    const encrypted = store[name];
    if (!encrypted) return null;

    try {
        return decrypt(encrypted, masterKey);
    } catch {
        return null;
    }
}

export function listSecretNames(): string[] {
    const store = loadStore();
    return Object.keys(store);
}

export function deleteSecret(name: string): boolean {
    const store = loadStore();
    if (!(name in store)) return false;
    delete store[name];
    saveStore(store);
    return true;
}

// ── File I/O ──────────────────────────────────

function loadStore(): SecretStore {
    try {
        if (fs.existsSync(SECRETS_FILE)) {
            return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
        }
    } catch { /* ignore */ }
    return {};
}

function saveStore(store: SecretStore): void {
    const dir = path.dirname(SECRETS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2), "utf-8");
}
