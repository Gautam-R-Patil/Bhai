// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import {
    Client,
    GatewayIntentBits,
    Events,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    ChannelType,
    type ChatInputCommandInteraction,
    type Message,
    type TextChannel,
    type ThreadChannel,
    type Attachment,
} from "discord.js";
import type { LLMClient } from "./llm.js";
import {
    runAgent,
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
    const embed = new EmbedBuilder()
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

    embed.setFooter({ text: "A.T.L.A.S" });
    return embed;
}

// ── Download Discord attachment to base64 ──

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

    try {
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64 = buffer.toString("base64");
        console.log(`  [DISCORD] Downloaded attachment: ${attachment.name} (${Math.round(buffer.length / 1024)}KB)`);
        return { type, base64, mimeType: mime || `${type}/${type === "image" ? "jpeg" : "mp4"}` };
    } catch (err) {
        console.warn(`  [DISCORD] Failed to download attachment ${attachment.name}:`, (err as Error).message);
        return null;
    }
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

// ── Send follow-up chunks after the initial editReply ──

async function sendFollowUps(
    interaction: ChatInputCommandInteraction,
    text: string,
): Promise<void> {
    const sanitized = sanitizeReply(text);
    if (!sanitized) return;

    const chunks = splitForDiscord(sanitized);
    if (chunks.length === 0) return;

    // First chunk goes to editReply
    await interaction.editReply(chunks[0]);

    // Remaining chunks as follow-ups
    for (let i = 1; i < chunks.length; i++) {
        try {
            await interaction.followUp(chunks[i]);
        } catch (err) {
            console.warn("[DISCORD] Follow-up failed:", (err as Error).message);
        }
    }
}

// ── Run agent and send the result ──

async function runAndReply(
    llm: LLMClient,
    message: string,
    interaction: ChatInputCommandInteraction,
    media?: MediaAttachment[],
    modelHint?: "simple" | "complex",
): Promise<void> {
    const progressCallback: ProgressCallback = async (msg: string) => {
        console.log(`  [DISCORD][progress] ${msg}`);
    };

    setSwarmProgress(progressCallback);
    setDeepResearchProgress(progressCallback);
    setLongTaskProgress(progressCallback);

    try {
        const result = await runAgent(llm, message, progressCallback, media, undefined, undefined, modelHint, undefined, { channel: "discord", userId: interaction.user.id, userName: interaction.user.username, isOwner: true });

        if (result.text.trim() === "[NO_REPLY]") {
            await interaction.editReply("Done -- no additional output.");
            return;
        }

        await sendFollowUps(interaction, result.text);
    } finally {
        clearSwarmProgress();
        clearDeepResearchProgress();
        clearLongTaskProgress();
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
            reason: `A.T.L.A.S ${embedTitle}`,
        });
    } catch (err) {
        console.warn("[DISCORD] Thread creation failed:", (err as Error).message);
        // Fall back to replying in channel
        await runAndReply(llm, message, interaction, undefined, modelHint);
        return;
    }

    await interaction.editReply(`Started in thread: <#${thread.id}>`);

    // Send initial status in thread
    await thread.send(`**${embedTitle}**\nWorking on it...`);

    let lastProgressUpdate = 0;
    const PROGRESS_THROTTLE_MS = 3000;

    const progressCallback: ProgressCallback = async (msg: string) => {
        console.log(`  [DISCORD][thread-progress] ${msg}`);
        const now = Date.now();
        if (now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
        lastProgressUpdate = now;

        // Skip internal messages
        const lower = msg.toLowerCase();
        if (lower.includes("still working") || lower.startsWith("error")) return;

        try {
            const truncated = msg.length > DISCORD_MSG_LIMIT - 50
                ? msg.substring(0, DISCORD_MSG_LIMIT - 53) + "..."
                : msg;
            await thread.send(`> ${truncated}`);
        } catch { /* thread may have been archived */ }
    };

    setSwarmProgress(progressCallback);
    setDeepResearchProgress(progressCallback);
    setLongTaskProgress(progressCallback);

    try {
        const result = await runAgent(llm, message, progressCallback, undefined, undefined, undefined, modelHint, undefined, { channel: "discord", userId: interaction.user.id, userName: interaction.user.username, isOwner: true });

        if (result.text.trim() === "[NO_REPLY]") {
            await thread.send("Completed -- no additional output.");
            return;
        }

        // Post final result as an embed
        const sanitized = sanitizeReply(result.text);
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
    } catch (err) {
        const errorType = categorizeError(err as Error);
        try {
            await thread.send(getErrorMessage(errorType));
        } catch { /* */ }
    } finally {
        clearSwarmProgress();
        clearDeepResearchProgress();
        clearLongTaskProgress();
    }
}

// ── Slash Command Definitions ────────────────

function buildSlashCommands(): SlashCommandBuilder[] {
    const ask = new SlashCommandBuilder()
        .setName("ask")
        .setDescription("Ask A.T.L.A.S anything")
        .addStringOption(option =>
            option.setName("message")
                .setDescription("Your message or question")
                .setRequired(true),
        ) as SlashCommandBuilder;

    const research = new SlashCommandBuilder()
        .setName("research")
        .setDescription("Start a deep research task")
        .addStringOption(option =>
            option.setName("topic")
                .setDescription("The research topic or question")
                .setRequired(true),
        ) as SlashCommandBuilder;

    const task = new SlashCommandBuilder()
        .setName("task")
        .setDescription("Start a long-running task")
        .addStringOption(option =>
            option.setName("description")
                .setDescription("What you want A.T.L.A.S to do")
                .setRequired(true),
        ) as SlashCommandBuilder;

    const status = new SlashCommandBuilder()
        .setName("status")
        .setDescription("Check A.T.L.A.S status and running tasks") as SlashCommandBuilder;

    const help = new SlashCommandBuilder()
        .setName("help")
        .setDescription("List available A.T.L.A.S commands") as SlashCommandBuilder;

    return [ask, research, task, status, help];
}

// ── Register Slash Commands ──────────────────

async function registerCommands(clientId: string, token: string): Promise<void> {
    const commands = buildSlashCommands();
    const rest = new REST({ version: "10" }).setToken(token);

    try {
        console.log("  [DISCORD] Registering slash commands...");
        await rest.put(
            Routes.applicationCommands(clientId),
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

// ── Init Discord Bot ─────────────────────────

let discordClient: Client | null = null;

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

    const allowedUsers = parseDiscordAllowedUsers();
    const startTime = Date.now();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.DirectMessages,
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

    client.once(Events.ClientReady, async (readyClient) => {
        console.log(`  [DISCORD] Bot online: ${readyClient.user.tag}`);

        // Register slash commands
        if (clientId) {
            await registerCommands(clientId, token);
        }
    });

    // ── Slash Command Handler ────────────────

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const userId = interaction.user.id;
        if (!isAllowed(userId)) {
            await interaction.reply({ content: "You are not authorized to use A.T.L.A.S.", ephemeral: true });
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
                        const agentMessage = `[DEEP RESEARCH REQUEST]\n\nTopic: ${topic}\n\nPlease conduct thorough deep research on this topic. Use the deep_research tool for comprehensive investigation.`;
                        await runInThread(llm, agentMessage, interaction, `Research: ${topic.substring(0, 80)}`, "Deep Research Results", "complex");
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
                        "A.T.L.A.S Status",
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
                        "A.T.L.A.S Commands",
                        "Here are the available commands:",
                        [
                            { name: "/ask <message>", value: "Ask A.T.L.A.S anything -- general questions, tool use, and more" },
                            { name: "/research <topic>", value: "Start a deep research task (runs in a thread with progress updates)" },
                            { name: "/task <description>", value: "Start a long-running task (runs in a thread with progress updates)" },
                            { name: "/status", value: "Check A.T.L.A.S uptime and running tasks" },
                            { name: "/help", value: "Show this help message" },
                            { name: "@mention", value: "Mention A.T.L.A.S in any channel or send a DM to chat" },
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

    client.on(Events.MessageCreate, async (message: Message) => {
        // Ignore bot messages (including our own)
        if (message.author.bot) return;

        // Check if this is a DM or an @mention
        const isDM = message.channel.type === ChannelType.DM;
        const isMention = message.mentions.has(client.user!);

        if (!isDM && !isMention) return;

        // Security check
        if (!isAllowed(message.author.id)) {
            console.log(`  [DISCORD] Blocked message from unauthorized user: ${message.author.tag}`);
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
            const progressCallback: ProgressCallback = async (msg: string) => {
                console.log(`  [DISCORD][msg-progress] ${msg}`);
            };

            setSwarmProgress(progressCallback);
            setDeepResearchProgress(progressCallback);
            setLongTaskProgress(progressCallback);

            const result = await runAgent(llm, content, progressCallback, media, undefined, undefined, undefined, undefined, { channel: "discord", userId: message.author.id, userName: message.author.username, isOwner: true });

            clearSwarmProgress();
            clearDeepResearchProgress();
            clearLongTaskProgress();

            if (result.text.trim() === "[NO_REPLY]") return;

            const sanitized = sanitizeReply(result.text);
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
    } catch (err) {
        console.error("[DISCORD] Login failed:", (err as Error).message);
        throw err;
    }
}

// ── Send a proactive message to Discord ──────

export async function sendDiscordProactiveMessage(message: string, filePath?: string): Promise<void> {
    if (!discordClient) return;

    const channelId = process.env.DISCORD_NOTIFICATIONS_CHANNEL_ID;
    if (!channelId) return;

    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || !("send" in channel)) return;

        const sanitized = sanitizeReply(message);

        // File attachment path — Discord renders images/videos inline from
        // attached files and renders other types as downloadable files.
        if (filePath) {
            try {
                const fs = await import("node:fs");
                const path = await import("node:path");
                if (fs.existsSync(filePath)) {
                    const buf = fs.readFileSync(filePath);
                    const fileName = path.basename(filePath);
                    const { AttachmentBuilder } = await import("discord.js");
                    const attachment = new AttachmentBuilder(buf, { name: fileName });
                    const firstChunk = splitForDiscord(sanitized)[0] ?? "";
                    await (channel as TextChannel).send({
                        content: firstChunk,
                        files: [attachment],
                    });
                    return;
                }
            } catch (fileErr) {
                console.warn("[DISCORD] Attachment send failed, falling back to text:", (fileErr as Error).message);
                // Fall through to plain text path
            }
        }

        const chunks = splitForDiscord(sanitized);
        for (const chunk of chunks) {
            await (channel as TextChannel).send(chunk);
        }
    } catch (err) {
        console.warn("[DISCORD] Failed to send proactive message:", (err as Error).message);
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
