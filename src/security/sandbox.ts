// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Container Sandbox ─────────────────────────
// Run shell commands in isolated Docker containers

import Dockerode from "dockerode";

// ── State ─────────────────────────────────────

let docker: Dockerode | null = null;
const DEFAULT_IMAGE = "node:20-alpine";

// ── Initialize ────────────────────────────────

export function initSandbox(): boolean {
    try {
        docker = new Dockerode();
        console.log("🐳 Docker sandbox initialized");
        return true;
    } catch (err) {
        console.log("ℹ️  Docker not available. Sandbox disabled.", (err as Error).message);
        return false;
    }
}

// ── Run in Container ──────────────────────────

export async function runInSandbox(
    command: string,
    args: string[] = [],
    options: {
        cwd?: string;
        timeout?: number;
        mountDirs?: string[];
        image?: string;
    } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!docker) {
        throw new Error("Docker sandbox not initialized");
    }

    const image = options.image || DEFAULT_IMAGE;
    const timeout = options.timeout || 30000;
    const mounts = (options.mountDirs || []).map((dir) => `${dir}:${dir}:rw`);

    const fullCommand = [command, ...args].join(" ");

    try {
        // Pull image if needed
        try {
            await docker.getImage(image).inspect();
        } catch {
            console.log(`  🐳 Pulling image: ${image}...`);
            const stream = await docker.pull(image);
            await new Promise<void>((resolve, reject) => {
                docker!.modem.followProgress(stream, (err: Error | null) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        // Create and run container
        const container = await docker.createContainer({
            Image: image,
            Cmd: ["sh", "-c", fullCommand],
            WorkingDir: options.cwd || "/workspace",
            HostConfig: {
                Binds: mounts,
                NetworkMode: "none", // No network access
                Memory: 256 * 1024 * 1024, // 256MB limit
                CpuPeriod: 100000,
                CpuQuota: 50000, // 50% CPU
                AutoRemove: true,
            },
        });

        await container.start();

        // Wait with timeout
        const result = await Promise.race([
            container.wait(),
            new Promise<{ StatusCode: number }>((_, reject) =>
                setTimeout(() => {
                    container.kill().catch(() => { });
                    reject(new Error("Container timeout"));
                }, timeout)
            ),
        ]);

        // Get logs
        const logs = await container.logs({ stdout: true, stderr: true });
        const output = logs.toString();

        return {
            stdout: output,
            stderr: "",
            exitCode: result.StatusCode,
        };
    } catch (err) {
        return {
            stdout: "",
            stderr: (err as Error).message,
            exitCode: 1,
        };
    }
}

// ── Check Docker Availability ─────────────────

export async function isDockerAvailable(): Promise<boolean> {
    if (!docker) return false;
    try {
        await docker.ping();
        return true;
    } catch {
        return false;
    }
}
