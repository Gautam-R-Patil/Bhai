// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// The Google tools run on the per-API @googleapis packages, not the googleapis
// monolith. Captures the request each generated client hands to the account's
// OAuth2Client, so the wire calls (URL, method, params) are pinned.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("googleapis", () => {
    throw new Error("googleapis must not load");
});

const { OAuth2Client } = createRequire(import.meta.url)("google-auth-library") as typeof import("google-auth-library");

type Req = { url: string; method?: string; params?: Record<string, unknown>; data?: unknown };
const sent: Req[] = [];
const replies: Record<string, unknown> = {
    "calendar/v3/calendars/primary/events": {
        items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-10-30T10:00:00Z" }, end: {} }],
    },
    "tasks/v1/lists/%40default/tasks": { items: [{ id: "t1", title: "Pay rent", status: "needsAction" }] },
    "gmail/v1/users/me/messages": { messages: [{ id: "m1" }] },
    "gmail/v1/users/me/messages/m1": {
        labelIds: ["IMPORTANT"],
        payload: {
            headers: [
                { name: "From", value: "a@b.com" },
                { name: "Subject", value: "Hi" },
            ],
        },
    },
    "oauth2/v2/userinfo": { email: "new@example.com" },
    "upload/youtube/v3/videos": { id: "vid1" },
};

let dir: string;
let api: typeof import("./google-api.js");

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gapi-"));
    mkdirSync(join(dir, "google-tokens"));
    writeFileSync(
        join(dir, "google-credentials.json"),
        JSON.stringify({ installed: { client_id: "cid", client_secret: "sec", redirect_uris: [] } }),
    );
    const token = { access_token: "tok", token_type: "Bearer", expiry_date: Date.now() + 3_600_000 };
    writeFileSync(join(dir, "google-tokens", "me@example_com.json"), JSON.stringify(token));
    vi.stubEnv("BHAI_DATA_DIR", dir);

    vi.spyOn(OAuth2Client.prototype, "request").mockImplementation(async (opts) => {
        const o = opts as Req;
        sent.push({ url: o.url, method: o.method, params: o.params, data: o.data });
        // Drain a multipart upload body so its file stream finishes inside the test.
        const body = o.data as NodeJS.ReadableStream | undefined;
        if (typeof body?.pipe === "function") await new Promise((r) => body.on("end", r).resume());
        const path = new URL(o.url).pathname.replace(/^\//, "");
        return { data: replies[path] ?? {}, status: 200 } as never;
    });
    vi.spyOn(OAuth2Client.prototype, "getToken").mockImplementation((async () => ({
        tokens: { access_token: "tok2", token_type: "Bearer" },
        res: null,
    })) as never);

    api = await import("./google-api.js");
    api.loadSavedAccounts();
});

afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
});

const last = (path: string) => sent.filter((r) => r.url.endsWith(path)).at(-1);

describe("Google API clients", () => {
    it("loads the saved account", () => {
        expect(api.getConnectedAccounts()).toEqual(["me@example.com"]);
    });

    it("lists calendar events through @googleapis/calendar", async () => {
        const events = await api.listCalendarEventsRaw({
            timeMin: "2026-10-30T00:00:00Z",
            timeMax: "2026-10-31T00:00:00Z",
        });
        expect(events.map((e) => e.summary)).toEqual(["Standup"]);
        expect(last("/calendar/v3/calendars/primary/events")).toMatchObject({
            url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            method: "GET",
            params: {
                timeMin: "2026-10-30T00:00:00Z",
                timeMax: "2026-10-31T00:00:00Z",
                maxResults: 25,
                singleEvents: true,
                orderBy: "startTime",
            },
        });
    });

    it("lists tasks through @googleapis/tasks", async () => {
        const tasks = await api.listGoogleTasksRaw({});
        expect(tasks.map((t) => t.title)).toEqual(["Pay rent"]);
        expect(last("/tasks/v1/lists/%40default/tasks")).toMatchObject({
            url: "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks",
            method: "GET",
            params: { showCompleted: false, maxResults: 100 },
        });
    });

    it("reads mail through @googleapis/gmail", async () => {
        const mail = await api.listStaleEmailsRaw();
        expect(mail).toMatchObject([{ id: "m1", from: "a@b.com", subject: "Hi", is_important: true }]);
        expect(last("/gmail/v1/users/me/messages")).toMatchObject({
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
            method: "GET",
            params: { q: "(is:unread OR is:important) older_than:3d -from:me", maxResults: 20 },
        });
        expect(last("/gmail/v1/users/me/messages/m1")).toMatchObject({
            method: "GET",
            params: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
        });
    });

    it("finds the account email through @googleapis/oauth2", async () => {
        const res = await api.completeGoogleAuth("code");
        expect(res).toEqual({ success: true, email: "new@example.com" });
        expect(last("/oauth2/v2/userinfo")).toMatchObject({
            url: "https://www.googleapis.com/oauth2/v2/userinfo",
            method: "GET",
        });
    });

    it("uploads a video through @googleapis/youtube", async () => {
        const video = join(dir, "clip.mp4");
        writeFileSync(video, "x");
        const { postYouTube } = await import("../marketing/adapters/youtube.js");
        const res = await postYouTube("brand", "Title", "Desc", video);
        expect(res).toEqual({ videoId: "vid1", url: "https://youtube.com/watch?v=vid1" });
        expect(last("/upload/youtube/v3/videos")).toMatchObject({
            url: "https://youtube.googleapis.com/upload/youtube/v3/videos",
            method: "POST",
            params: { part: ["snippet", "status"], uploadType: "multipart" },
        });
    });
});
