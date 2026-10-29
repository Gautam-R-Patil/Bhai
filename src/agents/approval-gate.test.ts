// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Swarm approval: the tool gate (swarm-context.ts) is the boundary. Inside a
// swarm run, external side effects run only in a step the owner approved (the
// Telegram buttons, or a yes that resumes the held steps); held-back calls are
// recorded and the step is reported as NOT done (excluded from replans, plain
// in synthesis). The gate goes by tool name and action (plus shell launchers
// in command position); generic browser/desktop input, reads, research and
// coding commands run. Outside a swarm nothing changes. The broad Telegram ask
// regex flags every irreversible phrasing seen in earlier rounds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient } from "../llm.js";

vi.mock("../tools/index.js", () => ({
    executeTool: async () => "ok",
    getToolSchemasByNames: () => [],
    getToolSchemas: () => [],
}));
vi.mock("../memory/sqlite.js", () => ({ getRawDb: () => null, recall: async () => [], remember: () => {} }));
const channel = { name: "overlay" };
vi.mock("../tools/channel-send.js", () => ({ getActiveChannel: () => channel.name }));
vi.mock("../utils/debug-log.js", () => ({
    extractPrimaryPath: () => undefined,
    logToolAction: () => {},
    summarizeToolCall: () => "",
}));
vi.mock("./self-heal.js", () => ({ attemptSelfHeal: async () => ({ fixed: false }) }));
vi.mock("./decomposition-library.js", () => ({ findTemplates: () => [], formatTemplateHint: () => "", saveTemplate: () => {} }));
const approvals = new Map<string, string>(); // step id → button answer ("timeout" times out)
vi.mock("./human-interrupt.js", () => ({
    requestHumanApproval: async (req: { question: string }) => {
        const id = /Step "([^"]+)"/.exec(req.question)?.[1] ?? "";
        const a = approvals.get(id) ?? "Skip";
        return a === "timeout" ? { answer: "Skip", timedOut: true } : { answer: a, timedOut: false };
    },
}));
const replanSpy = vi.fn();
vi.mock("./replanner.js", async (orig) => ({
    ...(await orig<typeof import("./replanner.js")>()),
    replan: (...a: unknown[]) => replanSpy(...a),
}));

const runSubAgentMock = vi.fn();
vi.mock("./sub-agent.js", async (orig) => ({
    ...(await orig<typeof import("./sub-agent.js")>()),
    runSubAgent: (...a: unknown[]) => runSubAgentMock(...a),
}));

const { executeMesh, shouldAskFirst } = await import("./mesh.js");
const { noteOwnerMessage, checkConsent, _resetConsent } = await import("../security/consent.js");
const { planAfterReplan, runSwarm, stepsToResume, _resetHeldRuns } = await import("./swarm.js");
const { swarmGate, swarmConsentKey, withSwarmRun, withSwarmStep, currentSwarmRun } = await import("./swarm-context.js");
type Run = import("./swarm-context.js").SwarmRunContext;

const llm = {} as LLMClient;
const ok = (id: string) => ({ id, role: "general", success: true, output: "done", toolCalls: 1, durationMs: 0, estimatedCost: 0 });
const newRun = (over: Partial<Run> = {}): Run => ({
    consentKey: swarmConsentKey("tidy up"),
    consentGranted: false,
    blocked: [],
    approvedSteps: new Set(),
    ...over,
});
const parse = (r: string | null) => JSON.parse(r as string);
const inStep = <T>(run: Run, approved: boolean, fn: () => Promise<T>) =>
    withSwarmRun(run, () => withSwarmStep({ stepId: "s1", stepApproved: approved }, fn));

// A sub-agent that tries one external send, as executeTool would see it.
async function sendingSubAgent(_l: unknown, t: { id: string }) {
    await new Promise((r) => setTimeout(r, t.id.endsWith("a") ? 5 : 1)); // interleave concurrent steps
    const g = await swarmGate("whatsapp_send", { to: `Rahul-${t.id}`, message: "hi" });
    if (g && g !== "allow") return { ...ok(t.id), success: false, output: "Sent!", error: "blocked" };
    return ok(t.id);
}

beforeEach(() => {
    _resetConsent();
    _resetHeldRuns();
    runSubAgentMock.mockReset();
    replanSpy.mockReset();
    approvals.clear();
    channel.name = "overlay";
});

describe("swarmGate (tool level)", () => {
    const GATED: Array<[string, Record<string, unknown>]> = [
        ["whatsapp_send", { to: "Rahul", message: "hi" }],
        ["whatsapp_sticker", { to: "Rahul" }],
        ["email_send", { to: "a@b.c", subject: "x", body: "y" }],
        ["send_message_on_channel", { channel: "slack", message: "hi" }],
        ["social_post", { platform: "twitter", caption: "x" }],
        ["messages_tool", { action: "send", to: "Mom", message: "hi" }],
        ["gmail", { action: "send", to: "a@b.c" }],
        ["site_task", { action: "confirm", amount: 200 }],
        ["delete_file", { path: "~/x" }],
        ["trash_manager", { action: "empty" }],
        ["app_manager", { action: "force_quit", app: "Slack" }],
        ["git_op", { operation: "push", branch: "feature" }],
        ["github", { action: "graphql", query: "mutation { addStar }" }],
        ["register_webhook", { description: "x" }],
        ["google_accounts", { action: "remove", email: "a@b.c" }],
        // code runners and launchers
        ["blender_script", { script: "import os; os.system('rm -rf ~/Documents')" }],
        ["davinci_script", { script: "x" }],
        ["open_in_app", { target: "shortcuts://run-shortcut?name=Pay%20Rent" }],
        ["open_in_app", { target: "/tmp/run.command" }],
        ["open_in_app", { target: "/tmp/notes.txt", app: "Terminal" }],
        // deferred work runs later, outside the gate (a long task resumes after a restart)
        ["cron", { op: "schedule", prompt: "Send the report to Rahul on WhatsApp", schedule: "1s" }],
        ["schedule_task", { expression: "* * * * *", description: "x", action: "email Rahul" }],
        ["set_reminder", { minutes: 1, description: "x", action: "email Rahul" }],
        ["task_queue", { action: "add", tasks: ["email Rahul"] }],
        ["start_long_task", { goal: "email the report to Rahul" }],
        ["resume_long_task", { task_id: "lt_1" }],
        // shell: what the main agent's per-call gate flags
        ["shell_exec", { command: "rm -rf ~/backups" }],
        ["shell_exec", { command: "git reset --hard HEAD~3" }],
        ["shell_exec_background", { command: "rm -rf ~/build" }],
        ["linux_shell_script", { script: "rm -r ~/x" }],
        // shell launchers that stand in for a gated tool, in command position
        ["shell_exec", { command: "shortcuts run 'Pay Rent'" }],
        // wrappers by absolute path, heredoc/stdin AppleScript, sh -c --
        ["shell_exec", { command: "/usr/bin/env shortcuts run 'Post Tweet'" }],
        ["shell_exec", { command: "/usr/bin/nohup open -a Terminal x.command" }],
        ["shell_exec", { command: "osascript <<'EOF'\ntell application \"Messages\" to send \"hi\" to buddy \"+15551234\"\nEOF" }],
        ["shell_exec", { command: "echo 'tell application \"Mail\" to send m' | osascript" }],
        ["shell_exec", { command: "bash -c -- 'shortcuts run Post'" }],
        ["shell_exec", { command: "sudo shortcuts run X" }],
        ["shell_exec", { command: 'open "shortcuts://run-shortcut?name=Pay%20Rent"' }],
        ["shell_exec", { command: "open tel:+15551234" }],
        ["shell_exec", { command: "cd /tmp && open -a Terminal x.command" }],
        ["shell_exec", { command: "open -a 'Script Editor' notes.txt" }],
        ["shell_exec", { command: "ls; open /tmp/run.sh" }],
        ["shell_exec", { command: "open /Applications/Installer.app" }],
        ["shell_exec", { command: `osascript -e 'tell application "Messages" to send "hi" to buddy "Rahul"'` }],
        ["shell_exec", { command: `env X=1 osascript -e 'tell application "System Events" to keystroke return'` }],
        // ... after shell keywords and wrappers, and inside sh -c / eval / $(...)
        ["shell_exec", { command: "if true; then shortcuts run X; fi" }],
        ["shell_exec", { command: "for i in 1; do open tel:1; done" }],
        ["shell_exec", { command: "{ shortcuts run X; }" }],
        ["shell_exec", { command: "! shortcuts run X" }],
        ["shell_exec", { command: `bash -c 'shortcuts run "Send Report"'` }],
        ["shell_exec", { command: 'sh -c "open tel:5551234"' }],
        ["shell_exec", { command: "zsh -lc 'cd /tmp; open x.command'" }],
        ["shell_exec", { command: 'eval "shortcuts run X"' }],
        ["shell_exec", { command: "echo X | xargs shortcuts run" }],
        ["shell_exec", { command: "nice shortcuts run X" }],
        ["shell_exec", { command: "timeout 10 shortcuts run X" }],
        ["shell_exec", { command: "caffeinate -i shortcuts run X" }],
        ["shell_exec", { command: "sudo -u bob shortcuts run X" }],
        ["shell_exec", { command: 'echo "$(shortcuts run X)"' }],
        ["shell_exec", { command: "sudo shutdown -h now" }],
        ["shell_exec", { command: "cat notes.txt && sudo reboot" }],
        ["shell_exec", { command: `bash -c "rm -rf ~/Documents"` }],
        // a read's text that a shell or eval then runs, and reads that run a command
        ["shell_exec", { command: "cat <<< 'rm -rf ~' | sh" }],
        ["shell_exec", { command: "grep -h . <<< 'sudo shutdown -h now' | bash" }],
        ["shell_exec", { command: "command -p cat <<< 'reboot' | zsh" }],
        ["shell_exec", { command: "sh < <(cat <<< 'reboot')" }],
        ["shell_exec", { command: "GIT_EXTERNAL_DIFF='rm -rf ~;' git diff --ext-diff HEAD~1" }],
        ["shell_exec", { command: "git grep -O'rm -rf ~;' foo" }],
        ["shell_exec", { command: "rg --pre shutdown x ." }],
        ["shell_exec", { command: "less +'!rm -rf ~' f" }],
        // shell_exec's args array is part of the command it runs
        ["shell_exec", { command: "shortcuts", args: ["run", "Post"] }],
        ["shell_exec", { command: "open", args: ["-a", "Terminal", "x.command"] }],
        ["shell_exec", { command: "rm", args: ["-rf", "~/"] }],
        ["shell_exec_background", { command: "shortcuts", args: ["run", "Post"] }],
        // open_in_app falls through an empty target like its handler does
        ["open_in_app", { target: "", path: "shortcuts://run-shortcut?name=Post" }],
        ["open_in_app", { target: "", url: "tel:123" }],
        // AppleScript forms of gated launchers
        ["apple_script", { script: `tell application "Terminal" to do script "ls"` }],
        ["apple_script", { script: `tell application "Shortcuts Events" to run shortcut "Post"` }],
        ["apple_script", { script: `open location "shortcuts://run-shortcut?name=Post"` }],
        ["shell_exec", { command: `osascript -e 'tell application "Shortcuts Events" to run shortcut "X"'` }],
        // open's getopt clusters
        ["shell_exec", { command: "open -na Terminal ./run" }],
        ["shell_exec", { command: "open -Wa Shortcuts" }],
        ["shell_exec", { command: "open -aTerminal ./deploy" }],
        ["apple_script", { script: 'do shell script "rm -rf ~/Backups"' }],
        ["apple_script", { script: 'tell application "Mail" to send theMessage' }],
        ["apple_script", { script: 'tell application "System Events" to keystroke return' }],
        // MCP: everything but read-only names
        ["mcp_slack__send_message", { text: "hi" }],
        ["mcp_shell__execute_command", { command: "rm -rf ~/x" }],
        ["mcp_twitter__tweet", { text: "hi" }],
        ["mcp_telegram__sendmessage", { text: "hi" }],
        ["mcp_db__query", { sql: "DROP TABLE users" }],
        // what requiresConfirmation flags (destructive hotkeys)
        ["os_type", { combo: "cmd+q" }],
        // writes through the browser's fetch
        ["browser_batch_fetch", { urls: ["https://app.example.com/api/messages/123"], method: "DELETE" }],
        ["browser_batch_fetch", { urls: ["https://app.example.com/api/orders"], method: "post" }],
    ];
    const NEVER: Array<[string, Record<string, unknown>]> = [
        // read-only MCP tools that lead with their service name
        ["mcp_brave__brave_web_search", { query: "x" }],
        ["mcp_firecrawl__firecrawl_scrape", { url: "https://x.com" }],
        ["mcp_tavily__tavily-search", { query: "x" }],
        ["mcp_context7__resolve-library-id", { libraryName: "react" }],
        // a code file opened in a named editor is opened, not run
        ["open_in_app", { target: "src/app.js", app: "Visual Studio Code" }],
        ["shell_exec", { command: "open -a 'Visual Studio Code' src/index.js" }],
        ["web_search", { query: "delete my account how" }],
        ["browser_scan", {}],
        ["browser_navigate", { url: "https://example.com" }],
        ["browser_extract", {}],
        ["browser_handle_captcha", {}],
        ["os_screenshot", {}],
        ["read_file", { path: "~/x" }],
        ["edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }],
        ["write", { file_path: "src/a.ts", content: "x" }],
        ["messages_tool", { action: "read_recent" }],
        ["send_file", { file_path: "/tmp/report.pdf" }],
        ["shell_kill_process", { process_id: "bg_1" }],
        ["test_run", {}],
        // research and coding shell
        ["shell_exec", { command: "ls -la" }],
        ["shell_exec", { command: "cat firebase.json" }],
        ["shell_exec", { command: "npm install firebase" }],
        ["shell_exec", { command: "gh pr view 12" }],
        ["shell_exec", { command: "grep -rn eval src/" }],
        ["shell_exec", { command: 'grep -rn "shortcuts run" src/ && echo open tel:1' }],
        ["shell_exec", { command: "open https://example.com && open report.pdf" }],
        ["shell_exec", { command: "open -a Preview report.pdf" }],
        ["shell_exec", { command: "open -na Preview report.pdf" }],
        ["shell_exec", { command: "grep -rn shutdown src/ && npm test" }],
        ["shell_exec", { command: `osascript -e 'tell application "Music" to get name of current track'` }],
        ["shell_exec", { command: "npm test && npx tsc --noEmit" }],
        ["shell_exec", { command: "grep -rn 'shutdown' src/" }],
        ["shell_exec", { command: "grep -rn reboot src/ | head -5" }],
        ["shell_exec", { command: "git log --oneline --grep shutdown" }],
        ["shell_exec", { command: `grep "a; open tel:1" notes.txt` }],
        ["shell_exec", { command: `osascript -e 'display notification "done"' && npm run remove-cache` }],
        ["shell_exec", { command: "cat src/mail/inbox.ts | grep -n send" }],
        ["shell_exec", { command: 'git status && git add -A && git commit -m "security: tidy"' }],
        ["shell_exec", { command: "git reset HEAD src/a.ts" }],
        ["shell_exec", { command: "curl -s http://localhost:3000/health" }],
        ["shell_exec", { command: "curl -sL https://api.github.com/repos/x/y | jq .stargazers_count" }],
        ["shell_exec", { command: "rm -rf dist .cache && npm run build" }],
        ["shell_exec", { command: "rm -rf ./packages/web/.next node_modules/.cache" }],
        ["shell_exec", { command: "find . -name '*.ts' -exec grep -l TODO {} \;" }],
        ["shell_exec", { command: `node -e "console.log(require('./package.json').version)"` }],
        ["shell_exec", { command: `python3 -c "import json,sys; print(json.load(sys.stdin)['a'])" < x.json` }],
        ["shell_exec", { command: "lsof -ti:3000 | xargs kill -9; npm run dev" }],
        ["shell_exec", { command: "kill -9 $(lsof -t -i:5173)" }],
        ["git_op", { operation: "status" }],
        ["git_op", { operation: "commit", message: "x" }],
        ["git_op", { operation: "checkpoint" }],
        ["cron", { op: "list" }],
        ["task_queue", { action: "status" }],
        ["github", { action: "graphql", query: "query { viewer { login } }" }],
        ["apple_script", { script: 'tell application "Music" to get name of current track' }],
        ["open_in_app", { target: "https://example.com" }],
        ["apple_script", { script: `open location "https://example.com"` }],
        ["shell_exec", { command: "cat", args: ["firebase.json"] }],
        ["open_in_app", { target: "/tmp/report.pdf", app: "Preview" }],
        ["mcp_docs__search", { q: "how to rm -rf" }],
        ["mcp_github__get_issue", { number: 1 }],
        ["mcp_notion__listPages", {}],
        // generic browser and desktop input (the accepted limit: not judged here)
        ["browser_click", { text: "Next page" }],
        ["browser_click_at", { label: 6 }],
        ["browser_type", { text: "usb-c hub", label: 3, press_enter: true }],
        ["browser_keyboard", { combo: "Enter" }],
        ["browser_run_js", { code: "return document.title" }],
        ["browser_parallel_tabs", { tab_actions: [{ url: "https://a.com", actions: [{ action: "extract" }] }] }],
        ["os_smart_click", { description: "Search button" }],
        ["os_type", { text: "hello there" }],
        ["os_type", { key: "tab" }],
        ["computer_use", { task: "find the downloads folder" }],
        ["browser_batch_fetch", { urls: ["https://api.example.com/items"] }],
        ["browser_batch_fetch", { urls: ["https://api.example.com/items"], method: "GET" }],
    ];

    it.each(GATED)("blocks %s %j inside a swarm without consent and records it", async (tool, args) => {
        const run = newRun();
        const res = await inStep(run, false, () => swarmGate(tool, args));
        expect(parse(res).needs_owner_approval).toBe(true);
        expect(parse(res).next_step).toMatch(/Do not retry/);
        expect(run.blocked).toEqual([expect.objectContaining({ step: "s1", tool })]);
    });

    it.each(GATED)("allows %s %j in a step the owner approved", async (tool, args) => {
        expect(await inStep(newRun(), true, () => swarmGate(tool, args))).toBe("allow");
        // a swarm nested in an approved step: the grant covers the whole run
        const nested = newRun({ consentGranted: true, approvedSteps: undefined });
        expect(await inStep(nested, false, () => swarmGate(tool, args))).toBe("allow");
    });

    it.each(NEVER)("never blocks %s %j", async (tool, args) => {
        const run = newRun();
        expect(await inStep(run, false, () => swarmGate(tool, args))).toBeNull();
        expect(run.blocked).toEqual([]);
    });

    it("does nothing outside a swarm run", async () => {
        for (const [tool, args] of GATED) expect(await swarmGate(tool, args)).toBeNull();
    });

    it("a granted re-run covers only the steps the owner was told about", async () => {
        const run = newRun({ consentGranted: true, approvedSteps: new Set(["s1"]) });
        expect(await inStep(run, false, () => swarmGate("email_send", { to: "priya@x.com" }))).not.toBe("allow");
        expect(run.blocked.map((b) => b.tool)).toEqual(["email_send"]);
    });

    it("gates dynamic (Forge, store) tools like MCP tools", async () => {
        const run = newRun();
        expect(parse(await inStep(run, false, () => swarmGate("slack_post_message", { text: "hi" }, true))).needs_owner_approval).toBe(
            true,
        );
        expect(parse(await inStep(run, false, () => swarmGate("weather_today", { city: "x" }, true))).needs_owner_approval).toBe(true);
        expect(await inStep(run, false, () => swarmGate("get_weather", { city: "x" }, true))).toBeNull();
    });

    it("does not register the owner ask mid-run", async () => {
        const run = newRun();
        await inStep(run, false, () => swarmGate("whatsapp_send", { to: "Rahul" }));
        noteOwnerMessage("yes");
        expect(checkConsent(run.consentKey, true)).toBe("needs_consent");
    });
});

describe("executeMesh with the tool gate", () => {
    it("marks a step NOT done when its side effect was held back, whatever the sub-agent said", async () => {
        runSubAgentMock.mockImplementation(sendingSubAgent);
        const run = newRun();
        const res = await withSwarmRun(run, () =>
            executeMesh(llm, [{ id: "s1", role: "researcher", description: "Summarize my notes", depends_on: [] }], undefined, 1000),
        );
        const r = res.results.get("s1");
        expect(r?.needsApproval).toBe(true);
        expect(r?.output).toMatch(/NOT done/);
        expect(r?.output).toMatch(/whatsapp_send → Rahul-s1/);
        expect(r?.output).toMatch(/SAME task text and confirmed: true/);
        expect(r?.output).not.toMatch(/Sent!/);
    });

    it("a refused payment fails the step instead of holding it for a confirmed re-run", async () => {
        runSubAgentMock.mockImplementation(async (_l: unknown, t: { id: string }) => {
            currentSwarmRun()?.blocked.push({
                step: t.id,
                tool: "vault_authorize_payment",
                summary: "vault_authorize_payment → shop.example",
            });
            return ok(t.id);
        });
        const run = newRun();
        const res = await withSwarmRun(run, () =>
            executeMesh(llm, [{ id: "s1", role: "browser", description: "Check out the cart", depends_on: [] }], undefined, 1000),
        );
        const r = res.results.get("s1");
        expect(r?.needsApproval).toBeFalsy();
        expect(r?.success).toBe(false);
        expect(r?.output).toMatch(/payment was NOT made/);
        expect(r?.output).not.toMatch(/confirmed: true/);
    });

    it("off Telegram never consults step text: a 'delete' step that only reads runs", async () => {
        runSubAgentMock.mockImplementation(async (_l: unknown, t: { id: string }) => ok(t.id));
        const res = await withSwarmRun(newRun(), () =>
            executeMesh(llm, [{ id: "s1", role: "general", description: "Delete the old backups", depends_on: [] }], async () => {}, 1000),
        );
        expect(res.results.get("s1")?.success).toBe(true);
    });

    it("on Telegram, Approve lets only that step through; concurrent steps don't share it", async () => {
        channel.name = "telegram";
        approvals.set("s_a", "Approve");
        runSubAgentMock.mockImplementation(sendingSubAgent);
        const run = newRun();
        const res = await withSwarmRun(run, () =>
            executeMesh(
                llm,
                [
                    { id: "s_a", role: "general", description: "Immediately send the report to Rahul", depends_on: [] },
                    { id: "s_b", role: "general", description: "Summarize my notes", depends_on: [] },
                ],
                async () => {},
                1000,
            ),
        );
        expect(res.results.get("s_a")?.success).toBe(true);
        expect(res.results.get("s_b")?.needsApproval).toBe(true);
        expect(run.blocked.map((b) => b.step)).toEqual(["s_b"]);
    });

    it("on Telegram, Skip declines the step without running it", async () => {
        channel.name = "telegram";
        const res = await withSwarmRun(newRun(), () =>
            executeMesh(llm, [{ id: "s1", role: "general", description: "Delete the old backups", depends_on: [] }], async () => {}, 1000),
        );
        expect(res.results.get("s1")?.declined).toBe(true);
        expect(runSubAgentMock).not.toHaveBeenCalled();
    });
});

describe("runSwarm consent", () => {
    const TASK = "Summarize my notes and message Rahul the summary";
    let PLAN = "";
    const plan = (steps: Array<{ id: string; description: string; depends_on?: string[] }>) => {
        PLAN = JSON.stringify({
            steps: steps.map((s) => ({ role: "general", depends_on: [], ...s })),
            reasoning: "parts",
        });
    };
    const prompts: string[] = [];
    const fakeLLM = {
        chat: async (req: { messages: Array<{ content: unknown }> }) => {
            prompts.push(req.messages.map((m) => String(m.content)).join("\n"));
            return { choices: [{ message: { content: PLAN } }] };
        },
    } as unknown as LLMClient;
    const calls: string[] = []; // step ids run
    const sends: string[] = []; // sends that actually went out
    const sendStep = (to: string) => async () => {
        const g = await swarmGate("whatsapp_send", { to });
        if (g && g !== "allow") return false;
        sends.push(to);
        return true;
    };
    const subAgentFor =
        (steps: Record<string, () => Promise<boolean>>) =>
        async (_l: unknown, t: { id: string }) => {
            calls.push(t.id);
            const done = steps[t.id] ? await steps[t.id]() : true;
            return done ? ok(t.id) : { ...ok(t.id), success: false, error: "Stopped: an action in this step needs the owner's OK" };
        };

    beforeEach(() => {
        prompts.length = 0;
        calls.length = 0;
        sends.length = 0;
        plan([
            { id: "s1", description: "Summarize my notes" },
            { id: "s2", description: "Share the summary with Rahul", depends_on: ["s1"] },
        ]);
    });

    it("an unconfirmed run holds the send back, never replans it, and reports it plainly", async () => {
        runSubAgentMock.mockImplementation(subAgentFor({ s2: sendStep("Rahul") }));
        const res = await runSwarm(fakeLLM, TASK);
        expect(res.blocked).toEqual(["whatsapp_send → Rahul"]);
        expect(res.needsApproval).toEqual(["Share the summary with Rahul"]);
        expect(sends).toEqual([]);
        expect(replanSpy).not.toHaveBeenCalled();
        expect(prompts.some((p) => /Step s2 \(general\): NOT RUN — needs the user's approval/.test(p))).toBe(true);
        expect(currentSwarmRun()).toBeUndefined();
    }, 20000);

    it("a confirmed re-run after the owner's yes resumes only the held step; without the yes it is not granted", async () => {
        runSubAgentMock.mockImplementation(subAgentFor({ s2: sendStep("Rahul") }));
        await runSwarm(fakeLLM, TASK); // asks
        calls.length = 0;
        const noYes = await runSwarm(fakeLLM, TASK, undefined, true); // model-set flag alone
        expect(noYes.needsApproval).toEqual(["Share the summary with Rahul"]);
        expect(sends).toEqual([]);
        expect(calls).toEqual([]); // nothing re-run, nothing re-planned
        noteOwnerMessage("yes, send it");
        const yes = await runSwarm(fakeLLM, `  ${TASK.toUpperCase()} `, undefined, true);
        expect(yes.needsApproval).toEqual([]);
        expect(yes.blocked).toBeUndefined();
        expect(sends).toEqual(["Rahul"]);
        expect(calls).toEqual(["s2"]); // s1 already finished: not run again
        const unconfirmed = await runSwarm(fakeLLM, TASK);
        expect(unconfirmed.needsApproval).toEqual(["Share the summary with Rahul"]);
    }, 20000);

    it("a confirmed re-run doesn't repeat a send the owner approved on Telegram", async () => {
        channel.name = "telegram";
        approvals.set("s_a", "Approve");
        plan([
            { id: "s_a", description: "Send the report to Rahul" },
            { id: "s_b", description: "Share notes with Priya" }, // no ask-first verb: held at the tool
        ]);
        runSubAgentMock.mockImplementation(subAgentFor({ s_a: sendStep("Rahul"), s_b: sendStep("Priya") }));
        const first = await runSwarm(fakeLLM, TASK, async () => {});
        expect(first.needsApproval).toEqual(["Share notes with Priya"]);
        noteOwnerMessage("yes");
        await runSwarm(fakeLLM, TASK, async () => {}, true);
        expect(sends).toEqual(["Rahul", "Priya"]); // Rahul once
    }, 20000);

    it("one yes covers every delete in the held step", async () => {
        plan([{ id: "s1", description: "[Clean up disk] Delete the old backups" }]);
        const deleted: string[] = [];
        const deleteAll = async () => {
            for (const f of ["backup1", "backup2", "backup3", "backup4", "backup5"]) {
                const g = await swarmGate("delete_file", { path: `~/old_backups/${f}` });
                if (g && g !== "allow") return false; // the sub-agent stops at the first hold
                deleted.push(f);
            }
            return true;
        };
        runSubAgentMock.mockImplementation(subAgentFor({ s1: deleteAll }));
        const first = await runSwarm(fakeLLM, TASK);
        expect(first.blocked).toEqual(["delete_file → ~/old_backups/backup1"]);
        noteOwnerMessage("ok go ahead");
        const second = await runSwarm(fakeLLM, TASK, undefined, true);
        expect(second.needsApproval).toEqual([]);
        expect(deleted).toEqual(["backup1", "backup2", "backup3", "backup4", "backup5"]);
    }, 20000);

    it("an 'ok' the owner sent while the swarm was still running doesn't grant the later confirmed re-run", async () => {
        let spoke = false;
        runSubAgentMock.mockImplementation(
            subAgentFor({
                s2: async () => {
                    const done = await sendStep("Rahul")();
                    if (!spoke) noteOwnerMessage("ok"); // mid-run, after the block
                    spoke = true;
                    return done;
                },
            }),
        );
        const first = await runSwarm(fakeLLM, TASK);
        expect(first.needsApproval).toEqual(["Share the summary with Rahul"]);
        calls.length = 0;
        const noNewYes = await runSwarm(fakeLLM, TASK, undefined, true); // no owner message since it returned
        expect(noNewYes.needsApproval).toEqual(["Share the summary with Rahul"]);
        expect(sends).toEqual([]);
        expect(calls).toEqual([]);
        noteOwnerMessage("yes");
        const yes = await runSwarm(fakeLLM, TASK, undefined, true);
        expect(yes.needsApproval).toEqual([]);
        expect(sends).toEqual(["Rahul"]);
    }, 20000);

    it("the owner's OK covers the held step once: a replanned step reusing its id is gated again", async () => {
        let s2Runs = 0;
        runSubAgentMock.mockImplementation(async (_l: unknown, t: { id: string; description: string }) => {
            calls.push(t.id);
            if (t.id !== "s2") return ok(t.id);
            if (/Email Priya/.test(t.description)) {
                const g = await swarmGate("email_send", { to: "priya@x.com" });
                if (g && g !== "allow") return { ...ok(t.id), success: false, error: "held" };
                sends.push("priya@x.com");
                return ok(t.id);
            }
            s2Runs++;
            if (s2Runs === 1) return (await sendStep("Rahul")()) ? ok(t.id) : { ...ok(t.id), success: false };
            return { ...ok(t.id), success: false, error: "WhatsApp timed out" }; // approved, then fails
        });
        replanSpy.mockResolvedValue({
            action: "replan",
            reason: "try email instead",
            revisedSteps: [{ id: "s2", role: "general", description: "Email Priya the summary", depends_on: ["s1"] }],
        });
        await runSwarm(fakeLLM, TASK);
        noteOwnerMessage("yes");
        const res = await runSwarm(fakeLLM, TASK, undefined, true);
        expect(s2Runs).toBeGreaterThanOrEqual(2); // ran approved (and retried) before the replan
        expect(replanSpy).toHaveBeenCalled();
        expect(sends).toEqual([]);
        expect(res.blocked).toEqual(["email_send → priya@x.com"]);
        expect(res.needsApproval).toEqual(["Email Priya the summary"]);
    }, 20000);

    it("a Telegram ask that timed out still registers the ask, so the owner's later yes grants the re-run", async () => {
        channel.name = "telegram";
        approvals.set("s1", "timeout");
        plan([{ id: "s1", description: "Send the report to Rahul" }]);
        runSubAgentMock.mockImplementation(subAgentFor({ s1: sendStep("Rahul") }));
        const first = await runSwarm(fakeLLM, TASK, async () => {});
        expect(first.needsApproval).toEqual(["Send the report to Rahul"]);
        expect(calls).toEqual([]);
        noteOwnerMessage("yes");
        const second = await runSwarm(fakeLLM, TASK, async () => {}, true);
        expect(second.needsApproval).toEqual([]);
        expect(sends).toEqual(["Rahul"]);
    }, 20000);
});

describe("stepsToResume", () => {
    const step = (id: string, deps: string[] = []) => ({ id, role: "general" as const, description: id, depends_on: deps });
    it("re-runs held steps and the clean steps built on them; keeps finished, declined and side-effecting ones", () => {
        const steps = [step("a"), step("b", ["a"]), step("c", ["a"]), step("d"), step("e"), step("f", ["e"])];
        const results = new Map<string, Record<string, unknown>>([
            ["a", { ...ok("a"), success: false, needsApproval: true }],
            ["b", ok("b")],
            ["c", { ...ok("c"), mutatorsRan: ["append_file"] }],
            ["d", ok("d")],
            ["e", { ...ok("e"), success: false, declined: true }],
            ["f", { ...ok("f"), success: false }],
        ]) as never;
        expect(stepsToResume(steps, results).map((s) => s.id)).toEqual(["a", "b", "f"]);
    });
});

describe("shouldAskFirst (Telegram early ask, recall-first)", () => {
    const MUST_FLAG = [
        "[Clean up disk] Delete the old backups",
        "Deploy to staging, then to production",
        "In Gmail delete all promotional emails",
        "Immediately send the report to Rahul",
        "Delete all files in ~/Documents",
        "Remove all files in ~/Downloads",
        "Remove old node_modules folders",
        "Delete all my emails",
        "Wipe the laptop",
        "Erase the photos from last year",
        "Delete the GitHub repo",
        "git branch -D old-feature",
        "Drop the production database",
        "rm -rf ~/x",
        "Empty the trash",
        "Uninstall Slack",
        "Factory reset the phone",
        "git reset --hard HEAD~1",
        "Send a message to Rahul on WhatsApp",
        "Email Priya the Q3 summary",
        "Text Rahul that I'm late",
        "Message the team on Slack",
        "Post the update on LinkedIn",
        "Publish the package to npm",
        "Tweet the announcement",
        "Reply to the email from Bob",
        "Forward the email to Priya",
        "Buy the cheapest one",
        "Purchase tickets for the show",
        "Order a pizza from Dominos",
        "Proceed to checkout",
        "Check out the cart",
        "Pay the electricity bill",
        "Pay Alice ₹200",
        "Transfer $500 to John",
        "Wire the funds to the vendor",
        "Send money to Mom",
        "Deploy the app to production",
        "Push the build to prod",
        "vercel --prod",
        "Force-push to main",
        "Format the external drive",
        "Move the old files to Trash",
        "Run npm publish",
        "Send it",
        "Reply to all",
        "Open Gmail to delete the promotional emails",
        "Go to Amazon to buy the USB-C hub",
        "1. Delete the old backups",
        "- Uninstall Zoom",
    ];
    it.each(MUST_FLAG)("flags %s", (d) => expect(shouldAskFirst(d)).toBe(true));
    it("passes plain reads", () => {
        for (const d of ["Summarize my notes", "Research laptops under $1000", "Compare the two PDFs"]) {
            expect(shouldAskFirst(d)).toBe(false);
        }
    });
});

describe("planAfterReplan", () => {
    const step = (id: string, deps: string[] = []) => ({ id, role: "general" as const, description: id, depends_on: deps });
    const fail = (id: string) => ({ ...ok(id), success: false, error: "boom" }) as never;

    it("keeps unrevised failures in the plan and re-runs the steps built on a revised one", () => {
        const steps = [step("s1"), step("s2"), step("s3", ["s1"])];
        const results = new Map([["s1", fail("s1")], ["s2", fail("s2")], ["s3", fail("s3")]]);
        const next = planAfterReplan(steps, results, steps, [step("s1")]);
        expect(next.steps.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
        expect(next.wave.map((s) => s.id)).toEqual(["s1", "s3"]);
        expect(next.settled).toEqual(["s2"]);
    });

    it("drops a failed step the replanner replaced under a new id, and points its dependents at the new one", () => {
        const steps = [step("s1"), step("s2", ["s1"])];
        const results = new Map([["s1", fail("s1")], ["s2", fail("s2")]]);
        const retry = { ...step("s1_retry"), replaces: ["s1"] };
        const next = planAfterReplan(steps, results, steps, [retry]);
        expect(next.steps.map((s) => s.id).sort()).toEqual(["s1_retry", "s2"]);
        expect(next.wave.map((s) => s.id)).toEqual(["s1_retry", "s2"]);
        expect(next.wave[1].depends_on).toEqual(["s1_retry"]);
        expect(next.settled).toEqual([]);
    });
});
