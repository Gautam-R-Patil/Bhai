// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Calls a Site Skill in a child process (scripts/site-skill-host.cjs). The
// child gets a bare environment (no API keys) and 128MB of heap; every call has
// a deadline, after which the child is killed. Whatever comes back is validated
// before the runtime acts on it, so a skill that throws, hangs, exits, runs out
// of memory or returns garbage yields {fail} instead of taking the bot down.
//
// Only built-in skills (<bot>/site-skills) get plain require(); every other
// skill runs in the shim's vm context (no require, no process), and a missing
// or bad skill.json is a load error. Node's vm is not a security boundary, so
// store-installed skills still need review before they run.

import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveScript } from "../../config/paths.js";

const Target = z
    .object({ sel: z.string().max(300).optional(), text: z.string().max(300).optional() })
    .strict()
    .refine((t) => t.sel || t.text, "target needs sel or text");

const isRegex = (s: string) => {
    try {
        new RegExp(s, "i");
        return true;
    } catch {
        return false;
    }
};
// What an action is waiting to bring about, by a name the skill picks: an
// element appears (one that wasn't there before the action), one goes away,
// the URL matches (a regex) or a live region announces it (a regex). The first
// to hold wins and reaches the next step as ctx.lastOutcome.
const Outcome = z.union([
    Target,
    z.object({ gone: Target }).strict(),
    z.object({ url: z.string().max(300).refine(isRegex, "url must be a regex") }).strict(),
    z.object({ announced: z.string().max(300).refine(isRegex, "announced must be a regex") }).strict(),
]);
export type ExpectSpec = Record<string, z.infer<typeof Outcome>>;

const ActionBase = z
    .object({
        // pick: of the visible elements target.sel matches, click the one whose
        // label fits value (lib.rank); none or a tie → the step is refused.
        op: z.enum(["click", "type", "typeCode", "press", "waitFor", "navigate", "pick"]),
        target: Target.optional(),
        value: z.string().max(2000).optional(),
        times: z.number().int().min(1).max(10).optional(),
        field: z.string().max(40).optional(), // pick: the input the choice is for, named when refused
        expect: z
            .record(z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), Outcome)
            .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 8, "1 to 8 outcomes")
            .optional(),
    })
    .strict();
const pickOk = (a: z.infer<typeof ActionBase>) => a.op !== "pick" || (!!a.target?.sel && !!a.value);
export const ActionSchema = ActionBase.refine(pickOk, "pick needs target.sel and value");

export const StepResultSchema = z
    .object({
        actions: z.array(ActionSchema).max(100).optional(),
        options: z
            .array(z.object({ id: z.string().max(100), label: z.string().max(300), price: z.number().optional() }).strict())
            .max(50)
            .optional(),
        // The submit runs exactly once: no `times` (one yes, one order). It is
        // the declared commit itself, never a choice ranked at run time (pick).
        confirm: z
            .object({
                summary: z.string().max(500),
                amount: z.number().nonnegative(),
                submit: ActionBase.omit({ times: true }).refine((a) => a.op !== "pick", "the submit can't be a pick"),
            })
            .strict()
            .optional(),
        // An id from the skill's manifest (skill.json "questions"): the owner sees
        // the manifest's fixed prompt, never text the page or skill made up.
        needsUser: z.object({ question: z.string().max(40), retry: z.boolean().optional() }).strict().optional(),
        done: z.object({ summary: z.string().max(500) }).strict().optional(),
        // The site can't take this input (no such place, sold out, two that fit
        // equally): the owner picks again from what the page offers.
        refused: z
            .object({ field: z.string().max(40), available: z.array(z.string().max(200)).max(50) })
            .strict()
            .optional(),
        // kind says who can fix it (runtime.ts retryOf): the owner's input, the
        // owner on the page, a site that's down, or a skill the site outgrew.
        fail: z
            .object({
                reason: z.string().max(200),
                kind: z.enum(["input_rejected", "needs_owner", "site_error", "unexpected_page"]).optional(),
            })
            .strict()
            .optional(),
        state: z
            .record(z.string(), z.unknown())
            .refine((s) => JSON.stringify(s).length <= 20_000, "state too large")
            .optional(),
    })
    .strict();

export type SiteAction = z.infer<typeof ActionSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;

// The deadline bounds the skill's code (its load and step), not starting Node:
// a fresh child gets bootMs to say it's up, then the deadline starts.
const deadlineMs = () => Number(process.env.BHAI_SITE_SKILL_DEADLINE_MS ?? 5000);
const bootMs = () => Number(process.env.BHAI_SITE_SKILL_BOOT_MS ?? 30000);

function shimPath(): string {
    return (
        resolveScript("site-skill-host.cjs") ??
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/site-skill-host.cjs")
    );
}

export class SkillHost {
    private child: ChildProcess | undefined;
    private booted: ChildProcess | undefined;
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
        child.on("message", (m: { ready?: boolean }) => {
            if (m?.ready) this.booted = child;
        });
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
            const stepTimer = () => setTimeout(() => kill("skill_timeout"), deadlineMs());
            let timer = this.booted === child ? stepTimer() : setTimeout(() => kill("skill_boot_timeout"), bootMs());
            const onExit = () => {
                if (this.child === child) this.child = undefined;
                done({ fail: { reason: "skill_crashed" } });
            };
            const onMessage = (m: { id?: number; ok?: boolean; kind?: string; result?: unknown; ready?: boolean }) => {
                if (m?.ready) {
                    clearTimeout(timer);
                    timer = stepTimer();
                    return;
                }
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
