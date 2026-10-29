// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Data Types
// ---------------------------------------------------------------------------

export type WhatsAppUserRole = "owner" | "contact";

export interface WhatsAppUser {
    jid: string;
    role: WhatsAppUserRole;
    displayName?: string;
    pushName?: string;
    phoneNumber: string;
    addedAt: number;
    lastActive?: number;
}

export interface ContactProfile {
    jid: string;
    displayName: string;
    pushName?: string;
    phoneNumber: string;
    role: WhatsAppUserRole;
    notes: string;
    tags: string[];
    firstSeen: number;
    lastActive: number;
    messageCount: number;
    chatHistory: Array<{ role: string; content: string; timestamp: number }>;
    memories: Array<{ content: string; timestamp: number }>;
    context: Record<string, string>;
}

export interface PendingOTP {
    code: string;
    expiresAt: number;
}

export interface ContactRequest {
    id: string;
    jid: string;
    firstMessage: string;
    receivedAt: number;
    status: "pending" | "allowed" | "blocked";
    ownerNotifiedJid?: string;
}

export interface WhatsAppBotPersona {
    name: string;
    systemPrompt: string;
    allowedToolNames: string[];
    autoAllow: boolean;
}

export interface GroupMessage {
    id: string;
    sender: string;
    senderName: string;
    content: string;
    contentType: string;
    mediaCaption?: string;
    quotedMessageId?: string;
    quotedContent?: string;
    timestamp: number;
    isFromBot: boolean;
}

export interface GroupParticipant {
    jid: string;
    name: string;
    role: "admin" | "superadmin" | "member";
    messageCount: number;
    lastActive: number;
    firstSeen: number;
    topics: string[];
}

export interface WhatsAppGroup {
    jid: string;
    name: string;
    description?: string;
    status: "pending" | "active" | "muted";
    addedBy?: string;
    approvedBy?: string;
    joinedAt: number;
    participantCount: number;
    messageHistory: GroupMessage[];
    participants: Record<string, GroupParticipant>;
    tone: string;
    lastBotMessage?: number;
    botMessageCount: number;
    totalMessageCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.ATLAS_DATA_DIR || path.resolve("data");
const OWNERS_PATH = path.join(DATA_DIR, "whatsapp-owners.json");
const CONTACTS_DIR = path.join(DATA_DIR, "whatsapp-contacts");
const BLOCKLIST_PATH = path.join(DATA_DIR, "whatsapp-blocklist.json");
const PERSONA_PATH = path.join(DATA_DIR, "whatsapp-persona.json");
const GROUPS_DIR = path.join(DATA_DIR, "whatsapp-groups");

const MAX_CHAT_HISTORY = 200;
const MAX_MEMORIES = 100;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_PERSONA: WhatsAppBotPersona = {
    name: "Personal Assistant",
    systemPrompt:
        "You represent the owner and help people who contact them. You can check the owner's calendar availability and let people know when they're free. You CANNOT share the owner's emails, location, or any private details.",
    allowedToolNames: [
        "get_current_time",
        "web_search",
        "weather",
        "google_calendar",
    ],
    autoAllow: false,
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const owners: Map<string, WhatsAppUser> = new Map();
const contacts: Map<string, ContactProfile> = new Map();
const blocklist: Set<string> = new Set();
let pendingOTP: PendingOTP | null = null;
const pendingContactRequests: Map<string, ContactRequest> = new Map();
let persona: WhatsAppBotPersona = { ...DEFAULT_PERSONA };
const groups: Map<string, WhatsAppGroup> = new Map();

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function safeJid(jid: string): string {
    return jid.replace(/[@.]/g, "_");
}

function contactFilePath(jid: string): string {
    return path.join(CONTACTS_DIR, `${safeJid(jid)}.json`);
}

function persistOwners(): void {
    ensureDir(DATA_DIR);
    const arr = Array.from(owners.values());
    fs.writeFileSync(OWNERS_PATH, JSON.stringify(arr, null, 2), "utf-8");
}

function persistContact(jid: string): void {
    const profile = contacts.get(jid);
    if (!profile) return;
    ensureDir(CONTACTS_DIR);
    fs.writeFileSync(
        contactFilePath(jid),
        JSON.stringify(profile, null, 2),
        "utf-8",
    );
}

function persistBlocklist(): void {
    ensureDir(DATA_DIR);
    const arr = Array.from(blocklist);
    fs.writeFileSync(BLOCKLIST_PATH, JSON.stringify(arr, null, 2), "utf-8");
}

function persistPersona(): void {
    ensureDir(DATA_DIR);
    fs.writeFileSync(PERSONA_PATH, JSON.stringify(persona, null, 2), "utf-8");
}

function loadJson<T>(filePath: string, fallback: T): T {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf-8");
            return JSON.parse(raw) as T;
        }
    } catch {
        // Corrupted file — use fallback
    }
    return fallback;
}

function safeJidFilename(jid: string): string {
    return jid.replace(/[@.:]/g, "_");
}

function persistGroup(jid: string): void {
    const group = groups.get(jid);
    if (!group) return;
    ensureDir(GROUPS_DIR);
    fs.writeFileSync(
        path.join(GROUPS_DIR, safeJidFilename(jid) + ".json"),
        JSON.stringify(group, null, 2),
        "utf-8",
    );
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initGroups(): void {
    groups.clear();
    ensureDir(GROUPS_DIR);
    const files = fs.readdirSync(GROUPS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
        const filePath = path.join(GROUPS_DIR, file);
        const group = loadJson<WhatsAppGroup | null>(filePath, null);
        if (group && group.jid) {
            groups.set(group.jid, group);
        }
    }
}

export function initWhatsAppUsers(): void {
    // Load owners
    owners.clear();
    const ownerArr = loadJson<WhatsAppUser[]>(OWNERS_PATH, []);
    for (const o of ownerArr) {
        owners.set(o.jid, o);
    }

    // Load contacts from individual files
    contacts.clear();
    ensureDir(CONTACTS_DIR);
    const files = fs.readdirSync(CONTACTS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
        const filePath = path.join(CONTACTS_DIR, file);
        const raw = loadJson<Partial<ContactProfile> | null>(filePath, null);
        if (raw && raw.jid) {
            // Reconstruct with explicit defaults so array fields added in newer
            // versions are never undefined on contacts saved by older builds.
            const profile: ContactProfile = {
                jid: raw.jid,
                displayName: raw.displayName ?? jidToPhone(raw.jid),
                pushName: raw.pushName,
                phoneNumber: raw.phoneNumber ?? jidToPhone(raw.jid),
                role: raw.role ?? "contact",
                notes: raw.notes ?? "",
                tags: raw.tags ?? [],
                firstSeen: raw.firstSeen ?? Date.now(),
                lastActive: raw.lastActive ?? Date.now(),
                messageCount: raw.messageCount ?? 0,
                chatHistory: raw.chatHistory ?? [],
                memories: raw.memories ?? [],
                context: raw.context ?? {},
            };
            contacts.set(profile.jid, profile);
        }
    }

    // Load blocklist
    blocklist.clear();
    const blockArr = loadJson<string[]>(BLOCKLIST_PATH, []);
    for (const jid of blockArr) {
        blocklist.add(jid);
    }

    // Load persona — merge with DEFAULT_PERSONA so fields added in newer versions
    // (e.g. allowedToolNames) are present even when the saved file pre-dates them.
    persona = { ...DEFAULT_PERSONA, ...loadJson<Partial<WhatsAppBotPersona>>(PERSONA_PATH, {}) };

    // Load groups
    initGroups();
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

export function generateOTP(): PendingOTP {
    const code = String(crypto.randomInt(100_000, 1_000_000));
    pendingOTP = {
        code,
        expiresAt: Date.now() + OTP_TTL_MS,
    };
    return pendingOTP;
}

export function getActiveOTP(): string | null {
    if (!pendingOTP) return null;
    if (Date.now() > pendingOTP.expiresAt) {
        pendingOTP = null;
        return null;
    }
    return pendingOTP.code;
}

export function verifyOTP(jid: string, code: string): boolean {
    const active = getActiveOTP();
    if (!active) return false;
    if (code !== active) return false;
    // OTP matched — register as owner and consume the OTP
    addOwner(jid);
    pendingOTP = null;
    return true;
}

// ---------------------------------------------------------------------------
// Role checks
// ---------------------------------------------------------------------------

// Strip Baileys device-suffix (`:NN`) so `1234567890:99@s.whatsapp.net` and
// `1234567890@s.whatsapp.net` resolve to the same owner. `@lid` is a separate
// namespace; leave it intact for callers to dispatch by domain.
export function normalizeJid(jid: string): string {
    if (!jid) return jid;
    const atIdx = jid.indexOf("@");
    if (atIdx < 0) return jid;
    const local = jid.substring(0, atIdx);
    const domain = jid.substring(atIdx);
    const cleanLocal = local.split(":")[0];
    return `${cleanLocal}${domain}`;
}

export function isOwner(jid: string): boolean {
    if (owners.has(jid)) return true;
    const normalized = normalizeJid(jid);
    if (normalized !== jid && owners.has(normalized)) return true;
    for (const ownerJid of owners.keys()) {
        if (normalizeJid(ownerJid) === normalized) return true;
    }
    return false;
}

export function isContact(jid: string): boolean {
    return contacts.has(jid);
}

export function isBlocked(jid: string): boolean {
    return blocklist.has(jid);
}

// ---------------------------------------------------------------------------
// Owner management
// ---------------------------------------------------------------------------

export function addOwner(
    jid: string,
    displayName?: string,
    pushName?: string,
): void {
    const existing = owners.get(jid);
    const user: WhatsAppUser = {
        jid,
        role: "owner",
        displayName: displayName ?? existing?.displayName,
        pushName: pushName ?? existing?.pushName,
        phoneNumber: jidToPhone(jid),
        addedAt: existing?.addedAt ?? Date.now(),
        lastActive: Date.now(),
    };
    owners.set(jid, user);
    persistOwners();
}

export function removeOwner(jid: string): void {
    owners.delete(jid);
    persistOwners();
}

export function getOwners(): WhatsAppUser[] {
    return Array.from(owners.values());
}

// ---------------------------------------------------------------------------
// Contact management
// ---------------------------------------------------------------------------

export function allowContact(
    jid: string,
    displayName?: string,
    pushName?: string,
): void {
    // Remove from blocklist if present
    if (blocklist.has(jid)) {
        blocklist.delete(jid);
        persistBlocklist();
    }

    const existing = contacts.get(jid);
    const now = Date.now();

    const profile: ContactProfile = {
        jid,
        displayName: displayName ?? existing?.displayName ?? jidToPhone(jid),
        pushName: pushName ?? existing?.pushName,
        phoneNumber: jidToPhone(jid),
        role: "contact",
        notes: existing?.notes ?? "",
        tags: existing?.tags ?? [],
        firstSeen: existing?.firstSeen ?? now,
        lastActive: now,
        messageCount: existing?.messageCount ?? 0,
        chatHistory: existing?.chatHistory ?? [],
        memories: existing?.memories ?? [],
        context: existing?.context ?? {},
    };

    contacts.set(jid, profile);
    persistContact(jid);
}

export function blockContact(jid: string): void {
    // Remove from contacts
    contacts.delete(jid);
    // Delete contact file if it exists
    const filePath = contactFilePath(jid);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Ignore deletion errors
    }
    // Add to blocklist
    blocklist.add(jid);
    persistBlocklist();
}

export function getContacts(): ContactProfile[] {
    return Array.from(contacts.values());
}

export function getContactProfile(jid: string): ContactProfile | null {
    return contacts.get(jid) ?? null;
}

export function updateContactProfile(
    jid: string,
    updates: Partial<ContactProfile>,
): void {
    const profile = contacts.get(jid);
    if (!profile) return;

    // Apply updates but never overwrite the jid
    const { jid: _ignoreJid, ...rest } = updates;
    Object.assign(profile, rest);

    contacts.set(jid, profile);
    persistContact(jid);
}

export function searchContacts(query: string): ContactProfile[] {
    const q = query.toLowerCase();
    return Array.from(contacts.values()).filter((c) => {
        if (c.displayName.toLowerCase().includes(q)) return true;
        if (c.pushName && c.pushName.toLowerCase().includes(q)) return true;
        if (c.phoneNumber.includes(q)) return true;
        if (c.tags.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
    });
}

// ---------------------------------------------------------------------------
// Contact conversation history
// ---------------------------------------------------------------------------

export function getContactConversation(
    jid: string,
): Array<{ role: string; content: string; timestamp: number }> {
    const profile = contacts.get(jid);
    if (!profile) return [];
    return profile.chatHistory;
}

export function appendContactMessage(
    jid: string,
    role: string,
    content: string,
): void {
    const profile = contacts.get(jid);
    if (!profile) return;

    profile.chatHistory.push({ role, content, timestamp: Date.now() });

    // Cap at MAX_CHAT_HISTORY — trim oldest messages
    if (profile.chatHistory.length > MAX_CHAT_HISTORY) {
        profile.chatHistory = profile.chatHistory.slice(-MAX_CHAT_HISTORY);
    }

    profile.messageCount += 1;
    profile.lastActive = Date.now();

    persistContact(jid);
}

export function clearContactConversation(jid: string): void {
    const profile = contacts.get(jid);
    if (!profile) return;

    profile.chatHistory = [];
    persistContact(jid);
}

// ---------------------------------------------------------------------------
// Contact memories
// ---------------------------------------------------------------------------

export function addContactMemory(jid: string, content: string): void {
    const profile = contacts.get(jid);
    if (!profile) return;

    profile.memories.push({ content, timestamp: Date.now() });

    // Cap at MAX_MEMORIES — trim oldest
    if (profile.memories.length > MAX_MEMORIES) {
        profile.memories = profile.memories.slice(-MAX_MEMORIES);
    }

    persistContact(jid);
}

export function getContactMemories(
    jid: string,
): Array<{ content: string; timestamp: number }> {
    const profile = contacts.get(jid);
    if (!profile) return [];
    return profile.memories;
}

// ---------------------------------------------------------------------------
// Contact requests
// ---------------------------------------------------------------------------

export function createContactRequest(
    jid: string,
    firstMessage: string,
    ownerJid: string,
): ContactRequest {
    const request: ContactRequest = {
        id: crypto.randomUUID(),
        jid,
        firstMessage,
        receivedAt: Date.now(),
        status: "pending",
        ownerNotifiedJid: ownerJid,
    };
    pendingContactRequests.set(request.id, request);
    return request;
}

export function getPendingRequests(): ContactRequest[] {
    return Array.from(pendingContactRequests.values()).filter(
        (r) => r.status === "pending",
    );
}

export function resolveContactRequest(
    id: string,
    action: "allowed" | "blocked",
): ContactRequest | null {
    const request = pendingContactRequests.get(id);
    if (!request) return null;

    request.status = action;

    if (action === "allowed") {
        allowContact(request.jid);
    } else {
        blockContact(request.jid);
    }

    pendingContactRequests.delete(id);
    return request;
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

export function getPersona(): WhatsAppBotPersona {
    return { ...persona };
}

export function setPersona(updates: Partial<WhatsAppBotPersona>): void {
    Object.assign(persona, updates);
    persistPersona();
}

// ---------------------------------------------------------------------------
// Group management
// ---------------------------------------------------------------------------

export function addGroup(jid: string, name: string, addedBy?: string): WhatsAppGroup {
    const group: WhatsAppGroup = {
        jid,
        name,
        status: "pending",
        addedBy,
        joinedAt: Date.now(),
        participantCount: 0,
        messageHistory: [],
        participants: {},
        tone: "neutral",
        botMessageCount: 0,
        totalMessageCount: 0,
    };
    groups.set(jid, group);
    persistGroup(jid);
    return group;
}

export function removeGroup(jid: string): void {
    groups.delete(jid);
    const filePath = path.join(GROUPS_DIR, safeJidFilename(jid) + ".json");
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Ignore deletion errors
    }
}

export function getGroup(jid: string): WhatsAppGroup | null {
    return groups.get(jid) ?? null;
}

export function isGroupActive(jid: string): boolean {
    const group = groups.get(jid);
    return group?.status === "active";
}

export function isGroupPending(jid: string): boolean {
    const group = groups.get(jid);
    return group?.status === "pending";
}

export function isGroupMuted(jid: string): boolean {
    const group = groups.get(jid);
    return group?.status === "muted";
}

export function approveGroup(jid: string, ownerJid: string): void {
    const group = groups.get(jid);
    if (!group) return;
    group.status = "active";
    group.approvedBy = ownerJid;
    persistGroup(jid);
}

export function muteGroup(jid: string): void {
    const group = groups.get(jid);
    if (!group) return;
    group.status = "muted";
    persistGroup(jid);
}

export function unmuteGroup(jid: string): void {
    const group = groups.get(jid);
    if (!group) return;
    group.status = "active";
    persistGroup(jid);
}

export function getActiveGroups(): WhatsAppGroup[] {
    return Array.from(groups.values()).filter((g) => g.status === "active");
}

export function getPendingGroups(): WhatsAppGroup[] {
    return Array.from(groups.values()).filter((g) => g.status === "pending");
}

export function getAllGroups(): WhatsAppGroup[] {
    return Array.from(groups.values());
}

export function appendGroupMessage(groupJid: string, msg: GroupMessage): void {
    const group = groups.get(groupJid);
    if (!group) return;

    group.messageHistory.push(msg);

    // Cap at 200 messages — drop oldest
    if (group.messageHistory.length > MAX_CHAT_HISTORY) {
        group.messageHistory = group.messageHistory.slice(-MAX_CHAT_HISTORY);
    }

    group.totalMessageCount += 1;
    persistGroup(groupJid);
}

export function getGroupHistory(
    groupJid: string,
    limit: number = 50,
): GroupMessage[] {
    const group = groups.get(groupJid);
    if (!group) return [];
    return group.messageHistory.slice(-limit);
}

export function getGroupParticipant(
    groupJid: string,
    senderJid: string,
): GroupParticipant | null {
    const group = groups.get(groupJid);
    if (!group) return null;
    return group.participants[senderJid] ?? null;
}

export function updateGroupParticipant(
    groupJid: string,
    senderJid: string,
    updates: Partial<Omit<GroupParticipant, "jid">>,
): void {
    const group = groups.get(groupJid);
    if (!group) return;

    const now = Date.now();
    const existing = group.participants[senderJid];

    if (existing) {
        // Apply updates but never overwrite the jid
        Object.assign(existing, updates);
    } else {
        // Create new participant with defaults
        group.participants[senderJid] = {
            jid: senderJid,
            name: updates.name ?? senderJid,
            role: updates.role ?? "member",
            messageCount: updates.messageCount ?? 0,
            lastActive: updates.lastActive ?? now,
            firstSeen: updates.firstSeen ?? now,
            topics: updates.topics ?? [],
        };
    }

    persistGroup(groupJid);
}

export function updateGroupMetadata(
    jid: string,
    updates: Partial<Pick<WhatsAppGroup, "name" | "description" | "participantCount" | "tone">>,
): void {
    const group = groups.get(jid);
    if (!group) return;
    Object.assign(group, updates);
    persistGroup(jid);
}

export function searchGroups(query: string): WhatsAppGroup[] {
    const q = query.toLowerCase();
    return Array.from(groups.values()).filter((g) =>
        g.name.toLowerCase().includes(q),
    );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function jidToPhone(jid: string): string {
    const num = jid.split("@")[0];
    return `+${num}`;
}

export function phoneToJid(phone: string): string {
    const num = phone.replace(/[^0-9]/g, "");
    return `${num}@s.whatsapp.net`;
}
