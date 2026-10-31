// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The swarm/long-task progress hooks are process-wide: a slash command from a server channel
// must not register them, or the owner's running task reports its progress into that channel.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const handlers = new Map<string, (arg: unknown) => Promise<void>>();
vi.mock("discord.js", () => {
    class Client {
        on(ev: string, fn: (arg: unknown) => Promise<void>) {
            handlers.set(ev, fn);
        }
        once() {}
        async login() {}
    }
    const stub = class {};
    return {
        Client,
        GatewayIntentBits: {},
        Events: { InteractionCreate: "interactionCreate", MessageCreate: "messageCreate", ClientReady: "ready" },
        InteractionContextType: { PrivateChannel: 1 },
        ChannelType: {},
        Partials: {},
        SlashCommandBuilder: stub,
        REST: stub,
        Routes: {},
        EmbedBuilder: stub,
        AttachmentBuilder: stub,
    };
});
vi.mock("./agent.js", () => ({ runAgent: vi.fn(async () => ({ text: "ok", toolCalls: 0 })) }));
const hooks = vi.hoisted(() => ({
    setSwarmProgress: vi.fn(),
    clearSwarmProgress: vi.fn(),
    setDeepResearchProgress: vi.fn(),
    clearDeepResearchProgress: vi.fn(),
    setLongTaskProgress: vi.fn(),
    clearLongTaskProgress: vi.fn(),
}));
vi.mock("./tools/index.js", () => hooks);

process.env.BHAI_DATA_DIR = mkdtempSync(join(tmpdir(), "discord-hooks-"));
process.env.DISCORD_BOT_TOKEN = "t";
process.env.DISCORD_ALLOWED_USER_IDS = "owner,pal";
process.env.OWNER_DISCORD_IDS = "owner";
const { initDiscord } = await import("./discord.js");
await initDiscord({} as never);

function ask(userId: string, guildId: string | null) {
    return handlers.get("interactionCreate")!({
        isChatInputCommand: () => true,
        user: { id: userId, username: userId, tag: userId },
        guildId,
        context: 0,
        commandName: "ask",
        options: { getString: () => "hi" },
        deferReply: async () => {},
        editReply: async () => {},
        followUp: async () => {},
        inGuild: () => !!guildId,
    });
}

beforeEach(() => vi.clearAllMocks());

it("a server-channel /ask leaves the owner's progress hooks alone", async () => {
    await ask("pal", "g1");
    await ask("owner", "g1");
    for (const fn of Object.values(hooks)) expect(fn).not.toHaveBeenCalled();
});

it("the owner's DM /ask registers and clears them", async () => {
    await ask("owner", null);
    expect(hooks.setLongTaskProgress).toHaveBeenCalledTimes(1);
    expect(hooks.clearLongTaskProgress).toHaveBeenCalledTimes(1);
});
