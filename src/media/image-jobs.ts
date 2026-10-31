// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Image requests generate_image stopped waiting for: Bhai's server holds them in its queue until
// Azure has room. This polls them (after a restart too: data/image-jobs.json keeps only their
// metadata), saves the result the way the tool does and sends it to the chat that asked.

import fs from "node:fs";
import path from "node:path";
import type { GeneratedImage } from "../agent.js";
import { getDataDir } from "../config/paths.js";
import type { JobState } from "../tools/generate-image.js";

export interface ImageJob {
    jobIds: string[];
    prompt: string;
    kind: "generated" | "edited";
    slug: string;
    /** The image-memory key its versions go to: the owner's, or the guest's conversation. */
    history: string;
    sourcePath?: string;
    /** A local edit: the prepared (<=2048px, upright) source it is blended onto; deleted once saved. */
    blendSource?: string;
    /** The chat that asked (ChannelContext.replyTo; "owner" = a scheduled task's owner chats); unset = saved only. */
    target?: { channel: string; to: string };
    /** The owner's private chat: the channel's owner-only extras (image buttons). */
    ownerDm: boolean;
    createdAt: number;
    /** Settled: the line to send, and the saved images. Kept until it reaches the chat; never saved twice. */
    text?: string;
    files?: GeneratedImage[];
    /** A failed send waits before the next try: 5s, doubling to 5 min (a blocked bot, DND, a closed window). */
    nextTryAt?: number;
    tries?: number;
}

/**
 * Sends `text` then `images` to `to` with the channel's existing senders; to "owner", the way a
 * scheduled task's result goes. True once it got there; false or a throw = try again next tick.
 */
type Deliver = (to: string, images: GeneratedImage[], text: string, ownerDm: boolean) => Promise<boolean>;
const deliverers = new Map<string, Deliver>();

/** Each channel registers its sender at init. */
export function registerImageDelivery(channel: string, deliver: Deliver): void {
    deliverers.set(channel, deliver);
}

export const canDeliverImages = (channel?: string): boolean => !!channel && deliverers.has(channel);

const POLL_MS = 5_000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const jobsFile = () => path.join(getDataDir(), "image-jobs.json");
let jobs: ImageJob[] | undefined;
// Parts of a split request already finished, so a tick doesn't fetch their images again.
const finished = new Map<string, JobState>();
let timer: NodeJS.Timeout | undefined;
let ticking = false;

function pending(): ImageJob[] {
    if (!jobs)
        try {
            jobs = JSON.parse(fs.readFileSync(jobsFile(), "utf8")) as ImageJob[];
        } catch {
            jobs = [];
        }
    return jobs;
}

function persist(): void {
    const file = jobsFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(pending()), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
        console.log(`  🎨 image queue: can't save (${(e as Error).message})`);
    }
}

/** generate_image stopped waiting: the watcher finishes the job. */
export function trackImageJob(job: ImageJob): void {
    pending().push(job);
    persist();
    startImageJobs();
}

/** Polls while there are jobs (boot, after the channels registered; and each new job). */
export function startImageJobs(): void {
    if (timer || !pending().length) return;
    timer = setInterval(() => void checkImageJobs(), POLL_MS);
    timer.unref();
}

/** One look at every job: a finished one is saved once, then sent (tried each tick until it gets there) and dropped. */
export async function checkImageJobs(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        for (const job of [...pending()]) {
            if (!(await settle(job))) continue;
            jobs = pending().filter((j) => j !== job);
            persist();
        }
        if (!pending().length && timer) {
            clearInterval(timer);
            timer = undefined;
        }
    } finally {
        ticking = false;
    }
}

/** Whether the job is over: sent, or given up on after 24h (saved files stay in Images). */
async function settle(job: ImageJob): Promise<boolean> {
    const expired = Date.now() - job.createdAt >= GIVE_UP_MS;
    if (job.text === undefined) {
        if (!(await finish(job, expired))) return false;
        for (const id of job.jobIds) finished.delete(id);
        if (job.blendSource) fs.rmSync(job.blendSource, { force: true });
        persist();
    }
    if (!expired && (job.nextTryAt ?? 0) > Date.now()) return false;
    if (await deliver(job)) return true;
    if (expired) console.log(`  🎨 image queue: couldn't send "${job.slug}" for 24h; dropping it`);
    else {
        job.tries = (job.tries ?? 0) + 1;
        job.nextTryAt = Date.now() + Math.min(POLL_MS * 2 ** (job.tries - 1), 5 * 60_000);
        persist();
    }
    return expired;
}

/** Sets job.text (and job.files) once the result is in: saved, failed or given up on. False = still queued. */
async function finish(job: ImageJob, expired: boolean): Promise<boolean> {
    try {
        // Lazy: the channel modules import this one without loading the image client.
        const { awaitImageJobs, saveImages } = await import("../tools/generate-image.js");
        const r = await awaitImageJobs(job.jobIds, 0, finished);
        if ("ahead" in r) {
            if (!expired) return false;
            console.log(`  🎨 image queue: gave up on "${job.slug}" after 24h`);
            job.text = "Sorry, I gave up on that image: the image model stayed too busy for a whole day. Ask me again if you still want it.";
            return true;
        }
        const localSource = job.blendSource
            ? await fs.promises.readFile(job.blendSource).catch(() => undefined)
            : undefined;
        const files = await saveImages(r.images, {
            slug: job.slug,
            stamp: Date.now(),
            history: job.history,
            sourcePath: job.sourcePath,
            ...(localSource ? { localSource } : {}),
        });
        job.files = files.map((f) => ({
            path: f.file_path,
            mimeType: f.mime_type,
            prompt: job.prompt,
            kind: job.kind,
            ...(job.sourcePath ? { sourcePath: job.sourcePath } : {}),
        }));
        job.text = files.length > 1 ? "Here are your images." : "Here's your image.";
        console.log(`  🎨 image queue: "${job.slug}" ready → ${path.basename(files[0].file_path)}`);
    } catch (e) {
        console.log(`  🎨 image queue: "${job.slug}" failed: ${(e as Error).message}`);
        // An ImageError's text is written for the user; only a failure the server reported (a status,
        // not 404: a job cleaned up after 2h may have been made and charged) was refunded. Anything
        // else is local (saving, decoding) and its text can hold paths: a generic line.
        const status = e instanceof Error && e.name === "ImageError" ? (e as Error & { status?: number }).status : null;
        job.text =
            status === null
                ? "Sorry, something went wrong on my side with that image. Ask me again if you still want it."
                : `Sorry, that image didn't work out. ${(e as Error).message}${status && status !== 404 ? " The credits were refunded." : ""}`;
    }
    return true;
}

async function deliver(job: ImageJob): Promise<boolean> {
    if (!job.target) return true;
    const send = deliverers.get(job.target.channel);
    if (!send) return false;
    try {
        return await send(job.target.to, job.files ?? [], job.text ?? "", job.ownerDm);
    } catch (e) {
        console.log(`  🎨 image queue: sending "${job.slug}" failed: ${(e as Error).message}`);
        return false;
    }
}
