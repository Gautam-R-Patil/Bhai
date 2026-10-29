// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
    buildPlaybook,
    describeStep,
    extractSteps,
    hasUnresolvedError,
    lastCheck,
    looksSensitive,
    type PlaybookCall,
    verificationFailed,
} from "./playbooks.js";

const call = (fnName: string, fnArgs: Record<string, unknown> = {}, failed = false): PlaybookCall => ({
    fnName,
    fnArgs,
    failed,
});

const gmail = [
    call("browser_navigate", { url: "https://www.gmail.com/mail" }),
    call("browser_click_at", { label: "Compose" }),
    call("browser_type", { label: "To", text: "secret-friend@example.com" }),
    call("browser_type", { label: "Body", text: "my private message body" }),
    call("browser_click_at", { label: "Send" }),
    call("browser_get_text", { selector: ".toast" }),
];

describe("playbook steps", () => {
    it("keeps tool names and short targets, never typed text", () => {
        expect(extractSteps(gmail)).toEqual([
            "browser_navigate(gmail.com)",
            "browser_click_at(Compose)",
            "browser_type(To)",
            "browser_type(Body)",
            "browser_click_at(Send)",
            "browser_get_text",
        ]);
        expect(describeStep("os_type", { text: "hunter2" })).toBe("os_type");
        expect(describeStep("os_click_id", { text: "Downloads" })).toBe("os_click_id(Downloads)");
        expect(describeStep("app_manager", { action: "open", app: "Spotify" })).toBe("app_manager(Spotify)");
        expect(describeStep("apple_script", { script: 'tell application "Mail" to send' })).toBe("apple_script");
    });

    it("drops failed and non-screen calls, collapses repeats, caps at 12", () => {
        const calls = [
            call("recall_memory", { query: "x" }),
            call("os_screenshot"),
            call("os_screenshot"),
            call("os_smart_click", { instruction: "the Wi-Fi row" }, true),
            ...Array.from({ length: 20 }, (_, i) => call("os_smart_click", { instruction: `row ${i}` })),
        ];
        const steps = extractSteps(calls);
        expect(steps[0]).toBe("os_screenshot");
        expect(steps).toHaveLength(12);
        expect(steps).not.toContain("os_smart_click(the Wi-Fi row)");
    });

    it("an error is resolved only when the same tool later succeeds", () => {
        expect(hasUnresolvedError([call("browser_click", {}, true), call("browser_click")])).toBe(false);
        expect(hasUnresolvedError([call("browser_click", {}, true), call("browser_click_at")])).toBe(true);
    });
});

describe("playbook success rule", () => {
    const done = "Sent it ✅";

    it("learns a verified browser win with the host as context", () => {
        const pb = buildPlaybook("  send an email to Sam  ", gmail, done, false);
        expect(pb).toMatchObject({ category: "browser", context: "gmail.com", taskPattern: "send an email to Sam" });
        expect(pb?.steps).toHaveLength(6);
    });

    it("a page check that passed still isn't a win when the reply admits failure", () => {
        expect(buildPlaybook("send the email", gmail, "I couldn't send it, Gmail shows an error", false)).toBeNull();
        expect(buildPlaybook("send the email", gmail, "Sent! Anything else?", false)).not.toBeNull();
    });

    it("learns an os win with the app name only from a programmatic check, never a screenshot alone", () => {
        const acted = [
            call("app_manager", { action: "open", app: "Spotify" }),
            call("os_smart_click", { instruction: "Play" }),
        ];
        // A screenshot leaves the verdict to the reply's wording, which can't be read in every language.
        expect(buildPlaybook("play music", [...acted, call("os_screenshot")], "Playing now", false)).toBeNull();
        expect(
            buildPlaybook("toca música", [...acted, call("os_screenshot")], "No pude reproducirla.", false),
        ).toBeNull();
        const checked = [...acted, call("os_visual_verify", { expect_text: "Now Playing" })];
        expect(buildPlaybook("play music", checked, "Playing now", false)).toMatchObject({
            category: "os",
            context: "Spotify",
        });
        expect(
            buildPlaybook("play music", checked, "It asked me to sign in again, I couldn't continue.", false),
        ).toBeNull();
    });

    it("never keeps contacts as step targets, and takes the site/app only from browser/desktop calls", () => {
        const steps = [
            call("browser_navigate", { url: "https://mail.google.com" }),
            call("browser_click_at", { label: "priya.sharma@gmail.com" }),
            call("os_smart_click", { instruction: "chat with +91 98200 12345" }),
            call("browser_get_text", { selector: ".toast" }),
            call("web_asset_download", { url: "https://cdn.example.com/x.png" }),
        ];
        const pb = buildPlaybook("reply to the landlord", steps, "Sent.", false);
        expect(pb?.context).toBe("mail.google.com");
        expect(JSON.stringify(pb?.steps)).not.toMatch(/priya|98200/);
    });

    it("trims the task pattern to 120 chars", () => {
        const long = "send it ".repeat(40);
        expect(buildPlaybook(long, gmail, done, false)?.taskPattern.length).toBeLessThanOrEqual(120);
    });

    it("learns nothing when stuck, unverified, verified before the last action, or an error is left", () => {
        expect(buildPlaybook("t", gmail, done, true)).toBeNull();
        const unverified = gmail.slice(0, 5);
        expect(buildPlaybook("t", unverified, done, false)).toBeNull();
        expect(verificationFailed(unverified)).toBe(true);
        const checkedTooEarly = [...gmail, call("browser_click_at", { label: "Archive" })];
        expect(buildPlaybook("t", checkedTooEarly, done, false)).toBeNull();
        const leftBroken = [call("web_search", {}, true), ...gmail];
        expect(buildPlaybook("t", leftBroken, done, false)).toBeNull();
        const noAction = [call("browser_get_text")];
        expect(buildPlaybook("t", noAction, done, false)).toBeNull();
        expect(verificationFailed(noAction)).toBe(false);
    });

    it("a check that ran and failed after the last action is a failed verification", () => {
        const calls = [
            call("os_smart_click", { instruction: "Send" }),
            call("os_visual_verify", { expect_text: "Message sent" }, true),
        ];
        expect(lastCheck(calls)).toBe("failed");
        expect(verificationFailed(calls)).toBe(true);
        expect(buildPlaybook("send it", calls, "Couldn't confirm it sent", false)).toBeNull();
        // A later passing check of the same kind resolves it.
        const retried = [...calls, call("os_visual_verify", { expect_text: "Message sent" })];
        expect(lastCheck(retried)).toBe("checked");
        expect(verificationFailed(retried)).toBe(false);
    });

    it("never keeps a message with a card number or a password", () => {
        expect(looksSensitive("pay my bill with card 4111 1111 1111 1111")).toBe(true);
        expect(looksSensitive("log into chase, my password is Hunter2!x")).toBe(true);
        expect(looksSensitive("log into netflix, pw: Tr0ub4dor&3")).toBe(true);
        expect(looksSensitive("log into netflix with Tr0ub4dor&3")).toBe(true);
        expect(looksSensitive("send an email to Sam on gmail.com")).toBe(false);
        expect(buildPlaybook("log into chase, my password is Hunter2!x", gmail, done, false)).toBeNull();
    });
});

describe("playbook store", () => {
    let tl: typeof import("./task-learnings.js");
    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-"));
        process.env.ATLAS_DATA_DIR = dir;
        // A pruned store: one survivor whose id is past the entry count.
        const survivor = {
            id: "learn_250",
            category: "app",
            taskPattern: "old survivor",
            context: "Notes",
            whatWorked: [],
            whatFailed: [],
            tips: [],
            successScore: 1,
            timesReinforced: 1,
            lastSeen: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(dir, "task-learnings.json"), JSON.stringify({ learnings: [survivor] }));
        tl = await import("./task-learnings.js");
        tl.initTaskLearnings();
    });

    it("new ids continue past the highest stored id after a restart", () => {
        const l = tl.upsertLearning("app", "brand new", "Notes", [], [], [], 1);
        expect(l.id).toBe("learn_251");
    });

    it("a playbook with the same recipe merges however the task was worded", () => {
        const steps = ["browser_navigate(mail.example.com)", "browser_click_at(New)"];
        const a = tl.upsertLearning(
            "browser",
            "open compose",
            "mail.example.com",
            steps,
            [],
            [],
            1,
            "2026-10-29T00:00:00.000Z",
        );
        const b = tl.upsertLearning(
            "browser",
            "start a new mail",
            "mail.example.com",
            steps,
            [],
            [],
            1,
            "2026-10-29T01:00:00.000Z",
        );
        expect(b).toBe(a);
        expect(a.timesReinforced).toBe(2);
    });

    it("playbooks evict only playbooks", () => {
        for (let i = 0; i < 90; i++) {
            tl.upsertLearning(
                "browser",
                `task ${i}`,
                `site${i}.example`,
                [`browser_click_at(x${i})`],
                [],
                [],
                1,
                new Date().toISOString(),
            );
        }
        const all = tl.getAllLearnings();
        expect(all.filter((l) => l.lastVerifiedAt).length).toBeLessThanOrEqual(80);
        expect(all.some((l) => l.taskPattern === "old survivor")).toBe(true);
    });

    it("a verified win replaces the steps; a failed replay demotes; recall skips weak ones", () => {
        tl.upsertLearning("browser", "send an email on gmail", "gmail.com", ["old step"], [], [], 1);
        const steps = Array.from({ length: 12 }, (_, i) => `browser_click_at(s${i})`);
        const l = tl.upsertLearning(
            "browser",
            "send an email on gmail",
            "gmail.com",
            steps,
            [],
            [],
            1,
            "2026-10-29T00:00:00.000Z",
        );
        expect(l.whatWorked).toEqual(steps);
        expect(l.lastVerifiedAt).toBe("2026-10-29T00:00:00.000Z");

        const injected = new Set<string>();
        expect(tl.getTaskLearningsContext("send an email on gmail", undefined, injected)).toContain(
            "send an email on gmail",
        );
        expect(injected).toEqual(new Set([l.id]));

        tl.demoteLearnings(injected, new Date("2026-10-29T12:00:00Z"));
        expect(l.successScore).toBe(0.7);
        expect(l.whatFailed).toEqual(["replay failed 2026-10-29"]);
        expect(tl.recallLearnings("send an email on gmail")).toHaveLength(1);

        tl.demoteLearnings([l.id]);
        expect(l.successScore).toBe(0.4);
        expect(tl.recallLearnings("send an email on gmail")).toHaveLength(1);
        tl.demoteLearnings([l.id]);
        tl.demoteLearnings([l.id]);
        expect(l.successScore).toBe(0);
        expect(tl.recallLearnings("send an email on gmail")).toHaveLength(0);

        // A fresh verified win brings it straight back.
        tl.upsertLearning("browser", "send an email on gmail", "gmail.com", steps, [], [], 1, new Date().toISOString());
        expect(l.successScore).toBe(1);
        expect(tl.recallLearnings("send an email on gmail")).toHaveLength(1);
    });

    it("reflection's failure lessons are still recalled at score 0", () => {
        tl.upsertLearning("app", "export pdf from Preview", "Preview", [], ["File > Export greyed out"], [], 0);
        expect(tl.recallLearnings("export pdf from Preview")).toHaveLength(1);
    });

    it("plain (reflection) upserts still merge and cap at 10", () => {
        tl.upsertLearning("app", "export notes", "Notes", ["a", "b"], [], [], 0.8);
        const l = tl.upsertLearning("app", "export notes", "Notes", ["b", "c"], ["x"], [], 0.6);
        expect(l.whatWorked).toEqual(["a", "b", "c"]);
        expect(l.lastVerifiedAt).toBeUndefined();
        expect(l.successScore).toBeCloseTo(0.7);
    });
});
