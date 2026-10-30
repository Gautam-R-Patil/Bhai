// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The desktop app loads Baileys (wizard WhatsApp pairing) and imapflow (IMAP
// test) from the bot's node_modules: one shipped copy, the patched Baileys
// the bot runs, instead of a second unpatched one in app.asar.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktop = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(desktop, "main.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));

describe("desktop reuses the bot's Baileys and imapflow", () => {
    it("does not ship its own copies", () => {
        expect(Object.keys(pkg.dependencies)).not.toContain("@whiskeysockets/baileys");
        expect(Object.keys(pkg.dependencies)).not.toContain("imapflow");
    });

    it("requires them relative to BOT_DIR", () => {
        expect(main).not.toMatch(/(?<!bot)require\("(@whiskeysockets\/baileys|imapflow)"\)/);
        expect(main).toMatch(/const botRequire = createRequire\(path\.join\(BOT_DIR, "package\.json"\)\);/);
        expect(main).toContain('botRequire("@whiskeysockets/baileys")');
        expect(main.match(/botRequire\("imapflow"\)/g)).toHaveLength(2);
    });

    it("resolves both from the bot's node_modules (dev BOT_DIR is the repo root)", () => {
        const botDir = path.join(desktop, "..");
        const botRequire = createRequire(path.join(botDir, "package.json"));
        for (const name of ["@whiskeysockets/baileys", "imapflow"]) {
            const resolved = fs.realpathSync(botRequire.resolve(`${name}/package.json`));
            expect(resolved).toBe(fs.realpathSync(path.join(botDir, "node_modules", name, "package.json")));
        }
        expect(typeof botRequire("imapflow").ImapFlow).toBe("function");
    });
});

describe("Browser engine phase", () => {
    it("runs a Playwright CLI the bot actually ships", async () => {
        const { buildPhaseList } = require("../installer/phases.js");
        const phase = buildPhaseList({ installed: {}, workspace: {} }).find((p) => p.id === "playwright-chromium");
        const botDir = path.join(desktop, "..");
        let args;
        await phase.run(
            {
                BOT_DIR: botDir,
                runCommand: async (_cmd, a) => {
                    args = a;
                },
            },
            () => {},
        );
        const cli = path.relative(path.join(botDir, "node_modules"), args[0]);
        const botPkg = JSON.parse(fs.readFileSync(path.join(botDir, "package.json"), "utf8"));
        expect(Object.keys(botPkg.dependencies)).toContain(cli.split(path.sep)[0]);
        expect(fs.existsSync(args[0])).toBe(true);
        expect(args.slice(1)).toEqual(["install", "chromium"]);
    });
});
