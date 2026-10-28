// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Store MCP `npm install` must not run third-party install scripts, and must
// not hand the bot's secrets to npm or anything it spawns.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("child_process", async (orig) => ({
    ...(await orig<typeof import("child_process")>()),
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { runNpmInstall } = await import("./installer.js");

const SECRETS = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    GITHUB_TOKEN: "ghp_x",
    EMAIL_PASSWORD: "hunter2",
    OPENROUTER_API_KEY: "sk-or-v1-x",
    npm_config__authToken: "npm_x",
};

afterEach(() => {
    for (const k of Object.keys(SECRETS)) delete process.env[k];
    delete process.env.npm_config_registry;
    spawnMock.mockReset();
});

describe("runNpmInstall", () => {
    it("passes --ignore-scripts and an env without the bot's secrets", async () => {
        Object.assign(process.env, SECRETS, { npm_config_registry: "https://r.example/" });
        spawnMock.mockImplementation(() => {
            const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
            setImmediate(() => proc.emit("close", 0));
            return proc;
        });

        await runNpmInstall("/tmp/pkg");

        const [cmd, args, opts] = spawnMock.mock.calls[0];
        expect(cmd).toBe("npm");
        expect(args).toContain("--ignore-scripts");
        expect(opts.env).toBeDefined();
        for (const k of Object.keys(SECRETS)) expect(opts.env[k]).toBeUndefined();
        expect(opts.env.PATH).toBe(process.env.PATH);
        expect(opts.env.HOME).toBe(process.env.HOME);
        expect(opts.env.npm_config_registry).toBe("https://r.example/");
    });
});
