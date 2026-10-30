// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { parseQuickCommand, runQuickCommand } from "../quick-commands.js";

const tools = (m: string) => parseQuickCommand(m)?.map((s) => [s.tool, s.args]);

describe("parseQuickCommand", () => {
    it("parses a chain of everyday commands, all or nothing", () => {
        expect(tools("Set the volume to 30 percent, switch my Mac to light mode, and open the Bluetooth settings")).toEqual([
            ["set_volume", { level: 30 }],
            ["dark_mode", { mode: "light" }],
            ["open_settings", { pane: "bluetooth" }],
        ]);
        expect(tools("pause spotify and play blinding lights on apple music")).toEqual([
            ["spotify", { action: "pause" }],
            ["music_control", { action: "search_play", query: "blinding lights" }],
        ]);
        expect(tools("mute")).toEqual([["set_volume", { mute: true }]]);
        expect(tools("next song")).toEqual([["spotify", { action: "next" }]]);
        expect(tools("please lock my screen")).toEqual([["lock_screen", {}]]);
        expect(tools("Play my Favourite Songs playlist in Apple Music and tell me which song is playing")).toEqual([
            ["music_control", { action: "search_play", query: "my favourite songs playlist" }],
            ["spotify", { action: "now_playing" }],
        ]);
        expect(tools("what's playing?")).toEqual([["spotify", { action: "now_playing" }]]);
        expect(tools("What song is playing on Spotify right now?")).toEqual([["spotify", { action: "now_playing" }]]);
        expect(tools("what's playing in apple music")).toEqual([["music_control", { action: "now_playing" }]]);
    });

    it("keeps a song title with 'and' in one piece", () => {
        expect(tools("play rock and roll on spotify")).toEqual([["spotify", { action: "play", query: "rock and roll" }]]);
    });

    it("leaves anything it doesn't fully understand to the model", () => {
        for (const m of [
            "play something chill", // which app? the model knows the user's preference
            "set volume to 30 and send mom a hi on whatsapp", // one clause isn't a quick command
            "what's the weather in delhi",
            "open the file I downloaded yesterday",
            "turn the volume up a bit",
        ])
            expect(parseQuickCommand(m)).toBeNull();
    });
});

describe("runQuickCommand", () => {
    it("runs every step and answers without a model", async () => {
        const ran: string[] = [];
        const r = await runQuickCommand("set volume to 20 and switch to dark mode", async (tool) => {
            ran.push(tool);
            return JSON.stringify({ success: true });
        });
        expect(ran).toEqual(["set_volume", "dark_mode"]);
        expect(r?.reply).toBe("Volume is at 20%. Dark mode is on.");
    });

    it("answers what's playing from the player's own report", async () => {
        const r = await runQuickCommand("what song is playing", async () =>
            JSON.stringify({ success: true, mode: "local_app", playing: true, track: "Levitating", artist: "Dua Lipa" }),
        );
        expect(r?.reply).toBe("Now playing: Levitating – Dua Lipa.");
    });

    it("hands a failure to the model with what already ran", async () => {
        const r = await runQuickCommand("set volume to 20 and play xyzzy on apple music", async (tool) =>
            JSON.stringify(tool === "set_volume" ? { success: true } : { success: false, error: "not found" }),
        );
        expect(r?.reply).toBeUndefined();
        expect(r?.partial).toContain("Volume is at 20%.");
        expect(r?.partial).toContain("not found");
    });
});
