// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Store MCP `npm install` must not run third-party install scripts, must not
// let the package's .npmrc pick npm config, and must not hand the bot's
// secrets to npm or anything it spawns.

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Captured before any test sets a Windows TMP/TEMP, so mkdtemp never uses C:\\Tmp on Linux.
const TMP_BASE = tmpdir();
import { join } from "node:path";
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
const NETWORK = {
    HTTPS_PROXY: "http://proxy.corp:3128",
    NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
    TEMP: "C:\\Temp",
    TMP: "C:\\Tmp",
};
// The user's own env trying to undo a pin (any spelling) is overridden too.
const UNPINS = { NPM_CONFIG_IGNORE_SCRIPTS: "false", npm_config_git: "/opt/evil/gitbin" };

let dir = "";
afterEach(() => {
    for (const k of Object.keys({ ...SECRETS, ...NETWORK, ...UNPINS })) delete process.env[k];
    delete process.env.npm_config_registry;
    spawnMock.mockReset();
    if (dir) rmSync(dir, { recursive: true, force: true });
});

const spawnOk = () =>
    spawnMock.mockImplementation(() => {
        const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
        setImmediate(() => proc.emit("close", 0));
        return proc;
    });

describe("runNpmInstall", () => {
    it("passes --ignore-scripts and an env without the bot's secrets", async () => {
        Object.assign(process.env, SECRETS, NETWORK, { npm_config_registry: "https://r.example/" });
        spawnOk();
        dir = mkdtempSync(join(TMP_BASE, "npm-env-"));

        await runNpmInstall(dir);

        const [cmd, args, opts] = spawnMock.mock.calls[0];
        expect(cmd).toBe("npm");
        expect(args).toContain("--ignore-scripts");
        expect(opts.env).toBeDefined();
        for (const k of Object.keys(SECRETS)) expect(opts.env[k]).toBeUndefined();
        expect(opts.env.PATH).toBe(process.env.PATH);
        expect(opts.env.HOME).toBe(process.env.HOME);
        expect(opts.env.npm_config_registry).toBe("https://r.example/");
        // Corporate networks and Windows temp dirs still work.
        for (const [k, v] of Object.entries(NETWORK)) expect(opts.env[k]).toBe(v);
    });

    it("pins the npm config a package's .npmrc could use to run code, and deletes that .npmrc", async () => {
        Object.assign(process.env, UNPINS);
        spawnOk();
        dir = mkdtempSync(join(TMP_BASE, "npm-env-"));
        writeFileSync(join(dir, ".npmrc"), "git=./evil.sh\nglobal=true\nignore-scripts=false\n");

        await runNpmInstall(dir);

        expect(existsSync(join(dir, ".npmrc"))).toBe(false);
        const { env } = spawnMock.mock.calls[0][2];
        expect(env).toMatchObject({
            npm_config_ignore_scripts: "true",
            npm_config_allow_git: "none",
            npm_config_git: "git",
            npm_config_global: "false",
            npm_config_location: "project",
            NoDefaultCurrentDirectoryInExePath: "1",
        });
        expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBeUndefined();
    });
});
