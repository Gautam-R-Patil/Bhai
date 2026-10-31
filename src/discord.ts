// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
    AttachmentBuilder,
    Client,
    SlashCommandBuilder,
    EmbedBuilder,
    ChatInputCommandInteraction,
    Message,
    TextChannel,
    ThreadChannel,
    Attachment,
} from "discord.js";
import { STUCK_REPLY_LINE, withStuckReplyLine } from "./channel-text.js";
import type { LLMClient } from "./llm.js";
import { registerImageDelivery } from "./media/image-jobs.js";
import {
    runAgent,
    type GeneratedImage,
    type MediaAttachment,
    type ProgressCallback,
    type ChannelContext,
} from "./agent.js";
import {
    setSwarmProgress,
    clearSwarmProgress,
    setDeepResearchProgress,
    clearDeepResearchProgress,
    setLongTaskProgress,
    clearLongTaskProgress,
} from "./tools/index.js";
import {
    smartChunkMessage,
    categorizeError,
    getErrorMessage,
} from "./alive-ux.js";
import { parseStepLine } from "./step-status.js";

// ── Constants ────────────────────────────────

const DISCORD_MSG_LIMIT = 2000;
const DISCORD_EMBED_DESC_LIMIT = 4096;

// ── Strip internal debug blocks before sending ──

function sanitizeReply(text: string): string {
    return text
        .replace(/<system_log>[\s\S]*?<\/system_log>/g, "")
        .replace(/<tool_log[\s\S]*?<\/tool_log>/g, "")
        .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
        .trim();
}

// ── Split long text at Discord's 2000 char limit ──

function splitForDiscord(text: string): string[] {
    return smartChunkMessage(text, DISCORD_MSG_LIMIT);
}

// ── Build a rich embed for structured results ──

function buildResultEmbed(
    title: string,
    description: string,
    fields?: Array<{ name: string; value: string; inline?: boolean }>,
): EmbedBuilder {
    const embed = new djs.EmbedBuilder()
        .setTitle(title)
        .setColor(0x5865f2) // Discord blurple
        .setTimestamp();

    // Truncate description to embed limit
    if (description.length > DISCORD_EMBED_DESC_LIMIT) {
        embed.setDescription(description.substring(0, DISCORD_EMBED_DESC_LIMIT - 3) + "...");
    } else {
        embed.setDescription(description);
    }

    if (fields) {
        for (const field of fields.slice(0, 25)) { // Discord max 25 fields
            const val = field.value.length > 1024
                ? field.value.substring(0, 1021) + "..."
                : field.value;
            embed.addFields({ name: field.name, value: val, inline: field.inline ?? false });
        }
    }

    embed.setFooter({ text: "Bhai" });
    return embed;
}

// ── Download Discord attachment to base64 ──

const DISCORD_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function downloadAttachment(attachment: Attachment): Promise<MediaAttachment | null> {
    const mime = attachment.contentType || "";
    let type: "image" | "video" | "audio" | null = null;
    if (mime.startsWith("image/")) type = "image";
    else if (mime.startsWith("video/")) type = "video";
    else if (mime.startsWith("audio/")) type = "audio";
    else if (attachment.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i)) type = "image";
    else if (attachment.name?.match(/\.(mp4|mov|webm)$/i)) type = "video";
    else if (attachment.name?.match(/\.(mp3|ogg|wav|m4a)$/i)) type = "audio";

    if (!type) return null;

    // F6: 3-layer size cap — metadata, Content-Length, final body length.
    if (typeof attachment.size === "number" && attachment.size > DISCORD_MAX_ATTACHMENT_BYTES) {
        console.warn(`  [DISCORD] Rejecting oversized attachment ${attachment.name}: ${attachment.size} bytes`);
        return null;
    }

    try {
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return null;
        const cl = response.headers.get("content-length");
        if (cl && Number(cl) > DISCORD_MAX_ATTACHMENT_BYTES) {
            console.warn(`  [DISCORD] Rejecting oversized attachment ${attachment.name}: content-length ${cl}`);
            return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > DISCORD_MAX_ATTACHMENT_BYTES) {
            console.warn(`  [DISCORD] Rejecting oversized attachment ${attachment.name}: body ${buffer.length} bytes`);
            return null;
        }
        const base64 = buffer.toString("base64");
        console.log(`  [DISCORD] Downloaded attachment: ${attachment.name} (${Math.round(buffer.length / 1024)}KB)`);
        return { type, base64, mimeType: mime || `${type}/${type === "image" ? "jpeg" : "mp4"}` };
    } catch (err) {
        console.warn(`  [DISCORD] Failed to download attachment ${attachment.name}:`, (err as Error).message);
        return null;
    }
}

// F7: per-sender inbound rate limit.
const DISCORD_RATE_WINDOW_MS = 60_000;
const DISCORD_RATE_MAX = 20;
const discordRateBuckets = new Map<string, number[]>();
function discordRateLimitAllow(userId: string): boolean {
    const now = Date.now();
    const arr = discordRateBuckets.get(userId) || [];
    const fresh = arr.filter(ts => now - ts < DISCORD_RATE_WINDOW_MS);
    if (fresh.length >= DISCORD_RATE_MAX) {
        discordRateBuckets.set(userId, fresh);
        return false;
    }
    fresh.push(now);
    discordRateBuckets.set(userId, fresh);
    return true;
}

// ── Send a response, splitting if needed ──

async function sendResponse(
    target: ChatInputCommandInteraction | Message | TextChannel | ThreadChannel,
    text: string,
): Promise<void> {
    const sanitized = sanitizeReply(text);
    if (!sanitized) return;

    const chunks = splitForDiscord(sanitized);
    for (const chunk of chunks) {
        if ("editReply" in target && typeof target.editReply === "function") {
            // Interaction: first chunk edits the deferred reply, rest are follow-ups
            try {
                await (target as ChatInputCommandInteraction).editReply(chunk);
            } catch {
                try { await (target as ChatInputCommandInteraction).followUp(chunk); } catch { /* */ }
            }
        } else if ("send" in target && typeof target.send === "function") {
            await (target as TextChannel | ThreadChannel).send(chunk);
        } else if ("reply" in target && typeof target.reply === "function") {
            await (target as Message).reply(chunk);
        }
    }
}

// ── Stuck-report reply line ──

/**
 * Outside a DM Discord only hands Bhai messages that mention it (a reply to
 * its message counts), so a bare "retry it" in a channel or thread would
 * vanish: there the stuck report asks for a mention.
 */
const STUCK_MENTION_LINE = STUCK_REPLY_LINE.replace("Reply:", "@mention me with:");
export function discordStuckReplyText(res: { text: string; stuck?: boolean }, toOwner: boolean, isDM: boolean): string {
    if (isDM) return withStuckReplyLine(res, toOwner);
    return res.stuck && toOwner ? `${res.text}\n\n${STUCK_MENTION_LINE}` : res.text;
}

// ── Send follow-up chunks after the initial editReply ──

async function sendFollowUps(
    interaction: ChatInputCommandInteraction,
    text: string,
    keepReply = false, // the deferred reply already holds the contract line: don't overwrite it
): Promise<void> {
    const sanitized = sanitizeReply(text);
    if (!sanitized) return;

    const chunks = splitForDiscord(sanitized);
    if (chunks.length === 0) return;

    // First chunk goes to editReply
    if (!keepReply) await interaction.editReply(chunks[0]);

    // Remaining chunks as follow-ups
    for (let i = keepReply ? 0 : 1; i < chunks.length; i++) {
        try {
            await interaction.followUp(chunks[i]);
        } catch (err) {
            console.warn("[DISCORD] Follow-up failed:", (err as Error).message);
        }
    }
}

// ── The turn's generated images, as attachments after the reply (Discord shows them inline) ──

export async function sendImages(
    images: GeneratedImage[] | undefined,
    send: (msg: string | { files: AttachmentBuilder[] }) => Promise<unknown>,
    ownerDm: boolean,
): Promise<void> {
    if (!images?.length) return;
    const { AttachmentBuilder } = await import("discord.js");
    const attach = async (img: GeneratedImage) =>
        new AttachmentBuilder(await readFile(img.path), { name: basename(img.path) });
    try {
        await send({ files: await Promise.all(images.map(attach)) });
        return;
    } catch (err) {
        console.warn("[DISCORD] Failed to send images:", (err as Error).message);
    }
    // One file per send, so one too big or unreadable doesn't lose the rest.
    const failed: string[] = [];
    for (const img of images) {
        try {
            await send({ files: [await attach(img)] });
        } catch (err) {
            console.warn("[DISCORD] Failed to send image:", (err as Error).message);
            failed.push(img.path);
        }
    }
    if (failed.length && ownerDm)
        await send(`Couldn't send the image here; it's saved at ${failed.join(", ")}`).catch(() => {});
}

// ── Run agent and send the result ──

async function runAndReply(
    llm: LLMClient,
    message: string,
    interaction: ChatInputCommandInteraction,
    media?: MediaAttachment[],
    modelHint?: "simple" | "complex",
): Promise<void> {
    // The turn's contract line replaces the deferred "thinking…" reply; the answer then follows it.
    let contractShown = false;
    const progressCallback: ProgressCallback = async (msg: string) => {
        console.log(`  [DISCORD][progress] ${msg}`);
        if (!msg.startsWith("[ACK] ")) return;
        try {
            await interaction.editReply(msg.slice(6));
            contractShown = true;
        } catch {
            /* non-fatal */
        }
    };

    // The progress hooks are process-wide and only owner tools use them: only an owner turn
    // registers (and clears) them, or the owner's task progress lands in this chat.
    const ctx = { ...discordChannelContext(interaction.user, isBotDmInteraction(interaction)), replyTo: interaction.channelId };
    const senderIsOwner = ctx.isOwner;
    if (senderIsOwner) {
        setSwarmProgress(progressCallback);
        setDeepResearchProgress(progressCallback);
        setLongTaskProgress(progressCallback);
    }

    try {
        const result = await runAgent(llm, message, progressCallback, media, undefined, undefined, modelHint, undefined, ctx);

        if (result.text.trim() === "[NO_REPLY]") {
            // Never end on the promise: the reply holds the contract line, so the close goes below it.
            if (contractShown) await interaction.followUp("Done -- no additional output.");
            else await interaction.editReply("Done -- no additional output.");
            await sendImages(result.images, (msg) => interaction.followUp(msg), senderIsOwner);
            return;
        }

        const replyText = discordStuckReplyText(result, senderIsOwner, !interaction.inGuild());
        await sendFollowUps(interaction, replyText, contractShown);
        await sendImages(result.images, (msg) => interaction.followUp(msg), senderIsOwner);
    } finally {
        if (senderIsOwner) {
            clearSwarmProgress();
            clearDeepResearchProgress();
            clearLongTaskProgress();
        }
    }
}

// ── Run a long operation in a thread with progress ──

async function runInThread(
    llm: LLMClient,
    message: string,
    interaction: ChatInputCommandInteraction,
    threadName: string,
    embedTitle: string,
    modelHint?: "simple" | "complex",
): Promise<void> {
    // Create a thread from the interaction's channel
    const channel = interaction.channel;
    if (!channel || !("threads" in channel)) {
        await interaction.editReply("Cannot create a thread in this channel.");
        return;
    }

    let thread: ThreadChannel;
    try {
        thread = await (channel as TextChannel).threads.create({
            name: threadName.substring(0, 100),
            autoArchiveDuration: 1440, // 24 hours
            reason: `Bhai ${embedTitle}`,
        });
    } catch (err) {
        console.warn("[DISCORD] Thread creation failed:", (err as Error).message);
        // Fall back to replying in channel
        await runAndReply(llm, message, interaction, undefined, modelHint);
        return;
    }

    await interaction.editReply(`Started in thread: <#${thread.id}>`);

    // Send initial status in thread; the agent's contract line is later edited into it.
    const statusMsg = await thread.send(`**${embedTitle}**\nWorking on it...`);

    let lastProgressUpdate = 0;
    const PROGRESS_THROTTLE_MS = 3000;
    // A heartbeat repeats the last step line with a new elapsed time: edit
    // that message in place instead of posting a new one each ~20s.
    let lastStep: { key: string; msg: Message } | null = null;

    const progressCallback: ProgressCallback = async (msg: string) => {
        console.log(`  [DISCORD][thread-progress] ${msg}`);
        // The turn's contract line always goes out, without its internal tag.
        const isAck = msg.startsWith("[ACK] ");
        const text = isAck ? msg.slice(6) : msg;
        const now = Date.now();
        if (!isAck && now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
        lastProgressUpdate = now;

        // Skip internal messages
        const lower = text.toLowerCase();
        if (lower.includes("still working") || lower.startsWith("error")) return;

        try {
            const truncated =
                text.length > DISCORD_MSG_LIMIT - 50 ? `${text.substring(0, DISCORD_MSG_LIMIT - 53)}...` : text;
            // One ack, not two: the contract line replaces "Working on it...".
            if (isAck)
                await statusMsg.edit(`**${embedTitle}**\n${truncated}`).catch(() => thread.send(`> ${truncated}`));
            else {
                const line = parseStepLine(text);
                const key = line ? `${line.step}|${line.status}` : "";
                if (key && lastStep?.key === key) await lastStep.msg.edit(`> ${truncated}`);
                else {
                    const sent = await thread.send(`> ${truncated}`);
                    lastStep = key ? { key, msg: sent } : null;
                }
            }
        } catch { /* thread may have been archived */ }
    };

    const ctx = { ...discordChannelContext(interaction.user, isBotDmInteraction(interaction)), replyTo: thread.id };
    const senderIsOwner = ctx.isOwner;
    if (senderIsOwner) {
        setSwarmProgress(progressCallback);
        setDeepResearchProgress(progressCallback);
        setLongTaskProgress(progressCallback);
    }

    try {
        const result = await runAgent(llm, message, progressCallback, undefined, undefined, undefined, modelHint, undefined, ctx);

        if (result.text.trim() === "[NO_REPLY]") {
            await thread.send("Completed -- no additional output.");
            await sendImages(result.images, (msg) => thread.send(msg), senderIsOwner);
            return;
        }

        // Post final result as an embed
        const sanitized = sanitizeReply(discordStuckReplyText(result, senderIsOwner, false));
        const embed = buildResultEmbed(
            embedTitle,
            sanitized.substring(0, DISCORD_EMBED_DESC_LIMIT),
            [
                { name: "Tool Calls", value: String(result.toolCalls), inline: true },
            ],
        );

        try {
            await thread.send({ embeds: [embed] });
        } catch {
            // Embed might be too large; fall back to plain text
            const chunks = splitForDiscord(sanitized);
            for (const chunk of chunks) {
                try { await thread.send(chunk); } catch { /* */ }
            }
        }

        // If the result is very long, also send plain text after the embed
        if (sanitized.length > DISCORD_EMBED_DESC_LIMIT) {
            const remaining = sanitized.substring(DISCORD_EMBED_DESC_LIMIT);
            const chunks = splitForDiscord(remaining);
            for (const chunk of chunks) {
                try { await thread.send(chunk); } catch { /* */ }
            }
        }
        await sendImages(result.images, (msg) => thread.send(msg), senderIsOwner);
    } catch (err) {
        const errorType = categorizeError(err as Error);
        try {
            await thread.send(getErrorMessage(errorType));
        } catch { /* */ }
    } finally {
        if (senderIsOwner) {
            clearSwarmProgress();
            clearDeepResearchProgress();
            clearLongTaskProgress();
        }
    }
}

// ── Slash Command Definitions ────────────────

function buildSlashCommands(): SlashCommandBuilder[] {
    const ask = new djs.SlashCommandBuilder()
        .setName("ask")
        .setDescription("Ask Bhai anything")
        .addStringOption(option =>
            option.setName("message")
                .setDescription("Your message or question")
                .setRequired(true),
        ) as SlashCommandBuilder;

    const research = new djs.SlashCommandBuilder()
        .setName("research")
        .setDescription("Start a deep research task")
        .addStringOption(option =>
            option.setName("topic")
                .setDescription("The research topic or question")
                .setRequired(true),
        ) as SlashCommandBuilder;

    const task = new djs.SlashCommandBuilder()
        .setName("task")
        .setDescription("Start a long-running task")
        .addStringOption(option =>
            option.setName("description")
                .setDescription("What you want Bhai to do")
                .setRequired(true),
        ) as SlashCommandBuilder;

    const status = new djs.SlashCommandBuilder()
        .setName("status")
        .setDescription("Check Bhai status and running tasks") as SlashCommandBuilder;

    const help = new djs.SlashCommandBuilder()
        .setName("help")
        .setDescription("List available Bhai commands") as SlashCommandBuilder;

    return [ask, research, task, status, help];
}

// ── Register Slash Commands ──────────────────

async function registerCommands(clientId: string, token: string): Promise<void> {
    const commands = buildSlashCommands();
    const rest = new djs.REST({ version: "10" }).setToken(token);

    try {
        console.log("  [DISCORD] Registering slash commands...");
        await rest.put(
            djs.Routes.applicationCommands(clientId),
            { body: commands.map(c => c.toJSON()) },
        );
        console.log("  [DISCORD] Slash commands registered");
    } catch (err) {
        console.warn("[DISCORD] Failed to register slash commands:", (err as Error).message);
    }
}

// ── Allowed User IDs for Discord ─────────────

function parseDiscordAllowedUsers(): Set<string> {
    const raw = process.env.DISCORD_ALLOWED_USER_IDS;
    if (!raw) return new Set(); // Fail-CLOSED: unset = allow no one (was previously allow-all, which let any guild member drive the agent).
    const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
    return new Set(ids);
}

// F3: OWNER_DISCORD_IDS is a strict subset of DISCORD_ALLOWED_USER_IDS;
// only these IDs get isOwner: true.
function parseDiscordOwners(): Set<string> {
    const raw = process.env.OWNER_DISCORD_IDS;
    if (!raw) return new Set();
    return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isPlatformOwner(channel: "discord", userId: string): boolean {
    if (channel !== "discord") return false;
    return parseDiscordOwners().has(userId);
}

/**
 * A slash command run in Bhai's own DM. No guild alone isn't enough: a user-installed
 * command can run in a group DM, where everyone in it reads the reply.
 */
function isBotDmInteraction(interaction: ChatInputCommandInteraction): boolean {
    return !interaction.guildId && interaction.context !== djs.InteractionContextType.PrivateChannel;
}

/**
 * Owner powers (tools, memory, history) and private memory (forget, pins, corrections)
 * only for the owner in a DM with Bhai: a channel, thread or group reply is read by everyone in it.
 */
export function discordChannelContext(user: { id: string; username: string }, isDM: boolean): ChannelContext {
    const owner = isDM && isPlatformOwner("discord", user.id);
    return { channel: "discord", userId: user.id, userName: user.username, isOwner: owner, isPrivate: owner };
}

// ── Init Discord Bot ─────────────────────────

let discordClient: Client | null = null;
// discord.js loads only when a bot token is set (initDiscord), not at boot.
let djs: typeof import("discord.js");

export async function initDiscord(llm: LLMClient): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID;

    if (!token) {
        console.log("  [DISCORD] No DISCORD_BOT_TOKEN set -- skipping Discord channel");
        return;
    }
    if (!clientId) {
        console.warn("  [DISCORD] DISCORD_CLIENT_ID not set -- slash commands will not be registered");
    }

    djs = await import("discord.js");
    const allowedUsers = parseDiscordAllowedUsers();
    const startTime = Date.now();

    const client = new djs.Client({
        intents: [
            djs.GatewayIntentBits.Guilds,
            djs.GatewayIntentBits.GuildMessages,
            djs.GatewayIntentBits.MessageContent,
            djs.GatewayIntentBits.GuildVoiceStates,
            djs.GatewayIntentBits.DirectMessages,
        ],
    });

    // ── Track active tasks for /status ──
    const activeTasks = new Map<string, { description: string; startedAt: number; channel: string }>();
    let taskCounter = 0;

    // ── Security: check if user is allowed ──
    // allowedUsers is always a Set (possibly empty). Empty set = no one
    // is allowed; the operator must set DISCORD_ALLOWED_USER_IDS explicitly.
    function isAllowed(userId: string): boolean {
        return allowedUsers.has(userId);
    }

    // ── Ready Event ──────────────────────────

    client.once(djs.Events.ClientReady, async (readyClient) => {
        console.log(`  [DISCORD] Bot online: ${readyClient.user.tag}`);

        // Register slash commands
        if (clientId) {
            await registerCommands(clientId, token);
        }
    });

    // ── Slash Command Handler ────────────────

    client.on(djs.Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const userId = interaction.user.id;
        if (!isAllowed(userId)) {
            await interaction.reply({ content: "You are not authorized to use Bhai.", ephemeral: true });
            return;
        }
        if (!discordRateLimitAllow(userId)) {
            console.log(`  [DISCORD] Rate limit hit for user ${userId} — dropping`);
            return;
        }

        const commandName = interaction.commandName;
        console.log(`  [DISCORD] /${commandName} from ${interaction.user.tag}`);

        try {
            switch (commandName) {
                case "ask": {
                    const message = interaction.options.getString("message", true);
                    await interaction.deferReply();

                    // Download any attachments from the message
                    // Note: slash commands don't carry attachments, but we handle it gracefully
                    await runAndReply(llm, message, interaction);
                    break;
                }

                case "research": {
                    const topic = interaction.options.getString("topic", true);
                    await interaction.deferReply();

                    const taskId = `discord_research_${++taskCounter}`;
                    activeTasks.set(taskId, {
                        description: `Research: ${topic.substring(0, 80)}`,
                        startedAt: Date.now(),
                        channel: interaction.channelId,
                    });

                    try {
                        // Research runs on the owner's account and reports to the owner's DM, so it
                        // starts there: in a server channel the owner's tools are off (anyone reads it).
                        if (interaction.guildId) {
                            await interaction.editReply("Deep research runs in a DM with me: send `/research` there and the answer comes back in that DM.");
                        } else {
                            const agentMessage = `[DEEP RESEARCH REQUEST]\n\nTopic: ${topic}\n\nPlease conduct thorough deep research on this topic. Use the deep_research tool for comprehensive investigation.`;
                            await runAndReply(llm, agentMessage, interaction, undefined, "complex");
                        }
                    } finally {
                        activeTasks.delete(taskId);
                    }
                    break;
                }

                case "task": {
                    const description = interaction.options.getString("description", true);
                    await interaction.deferReply();

                    const taskId = `discord_task_${++taskCounter}`;
                    activeTasks.set(taskId, {
                        description: description.substring(0, 80),
                        startedAt: Date.now(),
                        channel: interaction.channelId,
                    });

                    try {
                        const agentMessage = `[LONG TASK REQUEST]\n\n${description}\n\nThis is a long-running task. Use the long_task tool if appropriate for multi-phase execution.`;
                        await runInThread(llm, agentMessage, interaction, `Task: ${description.substring(0, 80)}`, "Task Results", "complex");
                    } finally {
                        activeTasks.delete(taskId);
                    }
                    break;
                }

                case "status": {
                    // The owner's running tasks and channels are theirs to see.
                    if (!isPlatformOwner("discord", interaction.user.id)) {
                        await interaction.reply({ content: "Only Bhai's owner can see its status.", ephemeral: true });
                        break;
                    }
                    const uptimeMs = Date.now() - startTime;
                    const uptimeMin = Math.floor(uptimeMs / 60_000);
                    const uptimeHr = Math.floor(uptimeMin / 60);
                    const uptimeStr = uptimeHr > 0
                        ? `${uptimeHr}h ${uptimeMin % 60}m`
                        : `${uptimeMin}m`;

                    const taskList = activeTasks.size > 0
                        ? Array.from(activeTasks.entries()).map(([id, t]) => {
                            const elapsed = Math.floor((Date.now() - t.startedAt) / 1000);
                            return `- **${t.description}** (${elapsed}s, <#${t.channel}>)`;
                        }).join("\n")
                        : "No active tasks";

                    const embed = buildResultEmbed(
                        "Bhai Status",
                        "All systems operational.",
                        [
                            { name: "Uptime", value: uptimeStr, inline: true },
                            { name: "Active Tasks", value: String(activeTasks.size), inline: true },
                            { name: "Tasks", value: taskList },
                        ],
                    );

                    await interaction.reply({ embeds: [embed] });
                    break;
                }

                case "help": {
                    const embed = buildResultEmbed(
                        "Bhai Commands",
                        "Here are the available commands:",
                        [
                            { name: "/ask <message>", value: "Ask Bhai anything -- general questions, tool use, and more" },
                            { name: "/research <topic>", value: "Start a deep research task (in a DM with me; the answer and report come back there)" },
                            { name: "/task <description>", value: "Start a long-running task (runs in a thread with progress updates)" },
                            { name: "/status", value: "Check Bhai uptime and running tasks" },
                            { name: "/help", value: "Show this help message" },
                            { name: "@mention", value: "Mention Bhai in any channel or send a DM to chat" },
                        ],
                    );

                    await interaction.reply({ embeds: [embed] });
                    break;
                }

                default:
                    await interaction.reply({ content: "Unknown command.", ephemeral: true });
            }
        } catch (err) {
            console.error("[DISCORD] Command error:", err);
            const errorType = categorizeError(err as Error);
            const errorMsg = getErrorMessage(errorType);

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(errorMsg);
                } else {
                    await interaction.reply({ content: errorMsg, ephemeral: true });
                }
            } catch { /* interaction may have expired */ }
        }
    });

    // ── Message Handler (@mentions + DMs) ────

    client.on(djs.Events.MessageCreate, async (message: Message) => {
        // Ignore bot messages (including our own)
        if (message.author.bot) return;

        // Check if this is a DM or an @mention
        const isDM = message.channel.type === djs.ChannelType.DM;
        // A real @mention of Bhai, not @everyone/@here or a role ping.
        const isMention = message.mentions.has(client.user!, { ignoreEveryone: true, ignoreRoles: true });

        if (!isDM && !isMention) return;

        // Security check
        if (!isAllowed(message.author.id)) {
            console.log(`  [DISCORD] Blocked message from unauthorized user: ${message.author.tag}`);
            return;
        }
        if (!discordRateLimitAllow(message.author.id)) {
            console.log(`  [DISCORD] Rate limit hit for user ${message.author.tag} — dropping`);
            return;
        }

        // Strip the bot mention from the message content
        let content = message.content;
        if (isMention && client.user) {
            content = content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
        }

        // If empty after stripping mention, ignore (just a bare @mention)
        if (!content && message.attachments.size === 0) return;

        console.log(`  [DISCORD] ${isDM ? "DM" : "Mention"} from ${message.author.tag}: ${content.substring(0, 100)}`);

        // Handle attachments
        let media: MediaAttachment[] | undefined;
        if (message.attachments.size > 0) {
            const downloads = await Promise.all(
                Array.from(message.attachments.values()).map(a => downloadAttachment(a)),
            );
            const valid = downloads.filter((d): d is MediaAttachment => d !== null);
            if (valid.length > 0) media = valid;
        }

        // Add attachment context if media but no text
        if (!content && media) {
            const types = media.map(m => m.type).join(", ");
            content = `What's in this ${types}?`;
        }

        // Show typing indicator (guard against PartialGroupDMChannel which lacks sendTyping)
        const chan = message.channel;
        if ("sendTyping" in chan) {
            try { await chan.sendTyping(); } catch { /* */ }
        }
        const typingInterval = setInterval(async () => {
            if ("sendTyping" in chan) {
                try { await chan.sendTyping(); } catch { /* */ }
            }
        }, 8000); // Discord typing indicator lasts ~10s

        try {
            let contractShown = false;
            const progressCallback: ProgressCallback = async (msg: string) => {
                console.log(`  [DISCORD][msg-progress] ${msg}`);
                // The turn's contract line goes out as soon as the agent states it.
                if (!msg.startsWith("[ACK] ")) return;
                await message
                    .reply(msg.slice(6))
                    .then(() => {
                        contractShown = true;
                    })
                    .catch(() => {});
            };

            // Owner powers (tools, memory, history) only in a DM: a channel reply is read by
            // everyone in it. The progress hooks are process-wide and only owner tools use
            // them, so only an owner turn registers them (and always clears them).
            const ctx = { ...discordChannelContext(message.author, isDM), replyTo: message.channelId };
            const senderIsOwner = ctx.isOwner;
            if (senderIsOwner) {
                setSwarmProgress(progressCallback);
                setDeepResearchProgress(progressCallback);
                setLongTaskProgress(progressCallback);
            }
            let result: Awaited<ReturnType<typeof runAgent>>;
            try {
                result = await runAgent(llm, content, progressCallback, media, undefined, undefined, undefined, undefined, ctx);
            } finally {
                if (senderIsOwner) {
                    clearSwarmProgress();
                    clearDeepResearchProgress();
                    clearLongTaskProgress();
                }
            }

            if (result.text.trim() === "[NO_REPLY]") {
                // Never end on the promise: close the contract line.
                if (contractShown) await message.reply("Done -- no additional output.").catch(() => {});
                await sendImages(result.images, (msg) => message.reply(msg), senderIsOwner);
                return;
            }

            const sanitized = sanitizeReply(discordStuckReplyText(result, senderIsOwner, isDM));
            const chunks = splitForDiscord(sanitized);

            for (const chunk of chunks) {
                try {
                    await message.reply(chunk);
                } catch {
                    // If reply fails, send as a regular message
                    try {
                        if ("send" in message.channel) {
                            await (message.channel as TextChannel).send(chunk);
                        }
                    } catch (sendErr) {
                        console.warn("[DISCORD] Failed to send message:", (sendErr as Error).message);
                    }
                }
            }
            await sendImages(result.images, (msg) => message.reply(msg), senderIsOwner);
        } catch (err) {
            console.error("[DISCORD] Message handler error:", err);
            const errorType = categorizeError(err as Error);
            try {
                await message.reply(getErrorMessage(errorType));
            } catch { /* */ }
        } finally {
            clearInterval(typingInterval);
        }
    });

    // ── Login ────────────────────────────────

    try {
        await client.login(token);
        discordClient = client;
        registerImageDelivery("discord", async (to, images, text, ownerDm) => {
            // A scheduled task's: the owner's DM, as its own result goes.
            if (to === "owner") return sendDiscordProactiveMessage(text, undefined, undefined, images);
            const channel = await client.channels.fetch(to);
            if (!channel || !("send" in channel)) return false;
            const send = (msg: string | { files: AttachmentBuilder[] }) => (channel as TextChannel).send(msg);
            await send(text);
            await sendImages(images, send, ownerDm);
            return true;
        });
    } catch (err) {
        console.error("[DISCORD] Login failed:", (err as Error).message);
        throw err;
    }
}

// ── Send a proactive message to Discord ──────

/**
 * Resolves true once sent, false when not configured or the send failed. `toUserId` picks
 * which owner's DM (e.g. the one who started a research); a non-owner id is ignored.
 */
export async function sendDiscordProactiveMessage(
    message: string,
    filePath?: string,
    toUserId?: string,
    images?: GeneratedImage[],
): Promise<boolean> {
    if (!discordClient) return false;

    // Proactive messages carry the owner's private data: to the owner's DM. The configured
    // notifications channel is used only when no owner id is set (it may be shared).
    const owners = parseDiscordOwners();
    const ownerId = toUserId && owners.has(toUserId) ? toUserId : [...owners][0];
    const channelId = process.env.DISCORD_NOTIFICATIONS_CHANNEL_ID;
    if (!ownerId && !channelId) return false;

    try {
        const channel = ownerId
            ? await (await discordClient.users.fetch(ownerId)).createDM()
            : await discordClient.channels.fetch(channelId!);
        if (!channel || !("send" in channel)) return false;

        let chunks = splitForDiscord(sanitizeReply(message));

        // File attachment path — Discord renders images/videos inline from
        // attached files and renders other types as downloadable files.
        const refusedFile = filePath ? (await import("./security/sensitive-paths.js")).outboundFileRefusal(filePath) : null;
        if (refusedFile) console.warn(`[DISCORD] ${refusedFile}`);
        if (filePath && !refusedFile) {
            try {
                const fs = await import("node:fs");
                const path = await import("node:path");
                if (fs.existsSync(filePath)) {
                    const buf = fs.readFileSync(filePath);
                    const fileName = path.basename(filePath);
                    const { AttachmentBuilder } = await import("discord.js");
                    const attachment = new AttachmentBuilder(buf, { name: fileName });
                    await (channel as TextChannel).send({
                        content: chunks[0] ?? "",
                        files: [attachment],
                    });
                    // The rest of a long message follows as plain chunks below.
                    chunks = chunks.slice(1);
                }
            } catch (fileErr) {
                console.warn("[DISCORD] Attachment send failed, falling back to text:", (fileErr as Error).message);
                // Fall through to plain text path
            }
        }

        for (const chunk of chunks) {
            await (channel as TextChannel).send(chunk);
        }
        await sendImages(images, (msg) => (channel as TextChannel).send(msg), !!ownerId);
        return true;
    } catch (err) {
        console.warn("[DISCORD] Failed to send proactive message:", (err as Error).message);
        return false;
    }
}

// ── Close Discord Bot ────────────────────────

export function getDiscordStatus(): string {
    if (!discordClient) return "disabled";
    return discordClient.isReady() ? "connected" : "connecting";
}

export async function closeDiscord(): Promise<void> {
    if (discordClient) {
        console.log("  [DISCORD] Shutting down...");
        discordClient.destroy();
        discordClient = null;
    }
}
