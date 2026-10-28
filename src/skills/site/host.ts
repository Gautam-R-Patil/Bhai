// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Calls a Site Skill in a child process (scripts/site-skill-host.cjs). The
// child gets a bare environment (no API keys) and 128MB of heap; every call has
// a deadline, after which the child is killed. Whatever comes back is validated
// before the runtime acts on it, so a skill that throws, hangs, exits, runs out
// of memory or returns garbage yields {fail} instead of taking the bot down.
//
// This contains crashes; it is not a security sandbox (the child can still read
// files and use the network). Store-installed skills need review before they run.

import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveScript } from "../../config/paths.js";

const Target = z
    .object({ sel: z.string().max(300).optional(), text: z.string().max(300).optional() })
    .strict()
    .refine((t) => t.sel || t.text, "target needs sel or text");

export const ActionSchema = z
    .object({
        op: z.enum(["click", "type", "typeCode", "press", "waitFor", "navigate"]),
        target: Target.optional(),
        value: z.string().max(2000).optional(),
        times: z.number().int().min(1).max(10).optional(),
    })
    .strict();

export const StepResultSchema = z
    .object({
        actions: z.array(ActionSchema).max(100).optional(),
        options: z
            .array(z.object({ id: z.string().max(100), label: z.string().max(300), price: z.number().optional() }).strict())
            .max(50)
            .optional(),
        // The submit runs exactly once: no `times` (one yes, one order).
        confirm: z
            .object({ summary: z.string().max(500), amount: z.number().nonnegative(), submit: ActionSchema.omit({ times: true }) })
            .strict()
            .optional(),
        // An id from the skill's manifest (skill.json "questions"): the owner sees
        // the manifest's fixed prompt, never text the page or skill made up.
        needsUser: z.object({ question: z.string().max(40), retry: z.boolean().optional() }).strict().optional(),
        done: z.object({ summary: z.string().max(500) }).strict().optional(),
        fail: z.object({ reason: z.string().max(200) }).strict().optional(),
        state: z
            .record(z.string(), z.unknown())
            .refine((s) => JSON.stringify(s).length <= 20_000, "state too large")
            .optional(),
    })
    .strict();

export type SiteAction = z.infer<typeof ActionSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;

const deadlineMs = () => Number(process.env.ATLAS_SITE_SKILL_DEADLINE_MS ?? 5000);

function shimPath(): string {
    return (
        resolveScript("site-skill-host.cjs") ??
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/site-skill-host.cjs")
    );
}

export class SkillHost {
    private child: ChildProcess | undefined;
    private seq = 0;
    readonly spawned: ChildProcess[] = []; // for tests: no orphans

    constructor(private readonly skillPath: string) {}

    private spawn(): ChildProcess {
        const child = fork(shimPath(), [this.skillPath], {
            execPath: process.execPath,
            execArgv: ["--max-old-space-size=128"],
            env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
            serialization: "json",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child.on("error", () => {}); // reported through "exit"
        this.spawned.push(child);
        return child;
    }

    call(phase: string, ctx: unknown): Promise<StepResult> {
        if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) this.child = this.spawn();
        const child = this.child;
        const id = ++this.seq;
        return new Promise((resolve) => {
            let settled = false;
            const done = (r: StepResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.off("message", onMessage);
                child.off("exit", onExit);
                resolve(r);
            };
            const kill = (reason: string) => {
                child.kill("SIGKILL");
                if (this.child === child) this.child = undefined;
                done({ fail: { reason } });
            };
            const timer = setTimeout(() => kill("skill_timeout"), deadlineMs());
            const onExit = () => {
                if (this.child === child) this.child = undefined;
                done({ fail: { reason: "skill_crashed" } });
            };
            const onMessage = (m: { id?: number; ok?: boolean; kind?: string; result?: unknown }) => {
                if (m?.id !== id) return;
                if (!m.ok) return done({ fail: { reason: m.kind === "load_error" ? "skill_load_error" : "skill_error" } });
                const parsed = StepResultSchema.safeParse(m.result);
                done(parsed.success ? parsed.data : { fail: { reason: "skill_garbage" } });
            };
            child.on("message", onMessage);
            child.once("exit", onExit);
            try {
                child.send({ id, phase, ctx });
            } catch {
                kill("skill_crashed");
            }
        });
    }

    close(): void {
        this.child?.kill("SIGKILL");
        this.child = undefined;
    }
}
