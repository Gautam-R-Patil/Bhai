// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Cloud-grounding bake-off (ScreenSpot-style, built from this Mac): which vision model
// finds a named UI element in a screenshot most often, fastest and cheapest. Ground
// truth is the accessibility tree: a click counts when it lands inside the element's box.
//
//   npx tsx scripts/eval-grounding.ts collect          # window screenshots + targets → OUT_DIR
//   MODELS=claude-haiku-5-5,gpt-4.1-nano npx tsx scripts/eval-grounding.ts run
//
// Same prompt and downscale as src/screen/cloud-grounding.ts. Azure models need AZ_ENDPOINT
// and AZ_KEY, Claude needs ANTHROPIC_API_KEY. Only low-personal-content apps are captured,
// and only their own window (screenshots go to the model providers).
import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AxNode, dumpAccessibilityTree, flattenInteractive } from "../src/screen/ax-dump.js";
import { downscaleForVision, parseGroundingResponse } from "../src/screen/ui-tars.js";

const ex = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), "data", "eval-grounding");
const PER_APP = Number(process.env.PER_APP) || 8;

// Same as cloud-grounding.ts.
const SYSTEM =
    "You are a GUI grounding model. Given a screenshot and a target UI element, output ONLY a JSON object with the pixel coordinate to click. No prose.";
const prompt = (instruction: string, w: number, h: number) => `Target: ${instruction}

The screenshot is ${w}x${h} pixels. Respond with ONLY a JSON object: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}
Coordinates are in the screenshot's own pixel space (top-left origin).`;

// $ per 1M tokens: input, output (Azure retail; Haiku 5.5 / Sonnet 5.5 list).
const PRICES: Record<string, [number, number]> = {
    "gpt-4.1-nano": [0.1, 0.4],
    "gpt-4o-mini": [0.15, 0.6],
    "gpt-5-mini": [0.25, 2],
    "gpt-6.1-terra": [1, 5],
    "claude-haiku-5-5": [0.1, 0.5],
    "claude-sonnet-5-5": [3, 15],
};

interface Target {
    shot: string;
    instruction: string;
    box: { x: number; y: number; w: number; h: number }; // image pixels
    width: number;
    height: number;
}

const APPS: { app: string; prep?: string[] }[] = [
    { app: "Calculator" },
    { app: "System Settings" },
    { app: "TextEdit", prep: ['tell application "TextEdit" to make new document'] },
    { app: "Finder", prep: [`tell application "Finder" to open (POSIX file "${process.env.HOME}/Desktop/BhaiEval")`] },
];

const ROLE_WORD: Record<string, string> = {
    AXButton: "button",
    AXRow: "row",
    AXCheckBox: "checkbox",
    AXPopUpButton: "pop-up menu",
    AXMenuButton: "menu button",
    AXRadioButton: "tab",
    AXTextField: "text field",
    AXStaticText: "text",
    AXLink: "link",
    AXCell: "item",
};

async function collect() {
    mkdirSync(OUT_DIR, { recursive: true });
    const targets: Target[] = [];
    for (const { app, prep } of APPS) {
        await ex("open", ["-a", app]);
        await sleep(1500);
        for (const s of prep ?? []) await ex("osascript", ["-e", s]).catch(() => {});
        await sleep(1200);
        const dump = await dumpAccessibilityTree({ depth: 20 });
        const win = dump.root.children.find((n: AxNode) => n.role === "AXWindow");
        if (dump.error || !win || dump.app !== app) {
            console.log(`skip ${app}: ${dump.error ?? (win ? `front is ${dump.app}` : "no window")}`);
            continue;
        }
        const shot = join(OUT_DIR, `${app.replace(/\s+/g, "-")}.png`);
        await ex("screencapture", ["-x", "-o", `-R${win.x},${win.y},${win.w},${win.h}`, shot]);
        const scaled = await downscaleForVision(readFileSync(shot), { jpeg: true });
        writeFileSync(shot.replace(/\.png$/, ".jpg"), scaled.buf);
        const k = scaled.width / win.w; // points → image pixels
        // Labelled, visible, not tiny, unique label in the window; spread over the list.
        const seen = new Map<string, number>();
        // The front window's own subtree: Finder's tree also holds the desktop's icons,
        // whose boxes fall inside the window but are hidden behind it.
        const els = flattenInteractive({ ...dump, root: { ...dump.root, children: [win] } }).filter(
            (e) =>
                e.label.trim().length > 0 &&
                e.label.length <= 40 &&
                e.bbox.w >= 10 &&
                e.bbox.h >= 10 &&
                e.bbox.x >= win.x &&
                e.bbox.y >= win.y &&
                e.bbox.x + e.bbox.w <= win.x + win.w &&
                e.bbox.y + e.bbox.h <= win.y + win.h,
        );
        for (const e of els) seen.set(e.label, (seen.get(e.label) ?? 0) + 1);
        const unique = els.filter((e) => seen.get(e.label) === 1);
        const step = Math.max(1, Math.floor(unique.length / PER_APP));
        for (const e of unique.filter((_, i) => i % step === 0).slice(0, PER_APP)) {
            targets.push({
                shot: shot.replace(/\.png$/, ".jpg"),
                instruction: `the "${e.label}" ${ROLE_WORD[e.role] ?? "element"} in ${app}`,
                box: {
                    x: (e.bbox.x - win.x) * k,
                    y: (e.bbox.y - win.y) * k,
                    w: e.bbox.w * k,
                    h: e.bbox.h * k,
                },
                width: scaled.width,
                height: scaled.height,
            });
        }
        console.log(`${app}: ${unique.length} candidates, took ${targets.filter((t) => t.instruction.endsWith(app)).length}`);
    }
    writeFileSync(join(OUT_DIR, "targets.json"), JSON.stringify(targets, null, 1));
    console.log(`${targets.length} targets → ${OUT_DIR}`);
}

async function ground(model: string, t: Target): Promise<{ text: string; inTok: number; outTok: number }> {
    const b64 = readFileSync(t.shot).toString("base64");
    const text = prompt(t.instruction, t.width, t.height);
    if (model.startsWith("claude")) {
        const r = await new Anthropic().messages.create({
            model,
            max_tokens: 300,
            system: SYSTEM,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text },
                        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
                    ],
                },
            ],
        });
        const out = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        return { text: out, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens };
    }
    const res = await fetch(`${process.env.AZ_ENDPOINT}/chat/completions`, {
        method: "POST",
        headers: { "api-key": process.env.AZ_KEY ?? "", "content-type": "application/json" },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: SYSTEM },
                {
                    role: "user",
                    content: [
                        { type: "text", text },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
                    ],
                },
            ],
            response_format: { type: "json_object" },
            ...(model.startsWith("gpt-5") ? { reasoning_effort: "minimal" } : {}),
            ...(model.startsWith("gpt-6") ? { reasoning_effort: "none" } : {}),
        }),
    });
    const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
        error?: { message: string };
    };
    if (j.error) throw new Error(j.error.message);
    return { text: j.choices?.[0]?.message?.content ?? "", inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 };
}

async function run() {
    const targets: Target[] = JSON.parse(readFileSync(join(OUT_DIR, "targets.json"), "utf8"));
    const models = (process.env.MODELS ?? "claude-haiku-5-5,gpt-4.1-nano,gpt-4o-mini").split(",");
    for (const model of models) {
        let hits = 0;
        let cost = 0;
        let ms = 0;
        const misses: string[] = [];
        for (const t of targets) {
            const t0 = Date.now();
            try {
                const r = await ground(model, t);
                ms += Date.now() - t0;
                const [pin, pout] = PRICES[model] ?? [0, 0];
                cost += (r.inTok * pin + r.outTok * pout) / 1e6;
                const p = parseGroundingResponse(r.text);
                const m = 3; // px of slack around the box
                const hit =
                    !!p &&
                    p.x >= t.box.x - m &&
                    p.x <= t.box.x + t.box.w + m &&
                    p.y >= t.box.y - m &&
                    p.y <= t.box.y + t.box.h + m;
                if (hit) hits++;
                else misses.push(`${t.instruction} → ${p ? `(${Math.round(p.x)},${Math.round(p.y)})` : "unparseable"}`);
            } catch (err) {
                ms += Date.now() - t0;
                misses.push(`${t.instruction} → error ${(err as Error).message.slice(0, 80)}`);
            }
        }
        const n = targets.length;
        console.log(
            `${model.padEnd(18)} ${hits}/${n} (${Math.round((100 * hits) / n)}%)  ${Math.round(ms / n)}ms/target  $${(cost / n).toFixed(5)}/target`,
        );
        if (process.env.VERBOSE) for (const miss of misses) console.log(`   ✗ ${miss}`);
    }
}

await (process.argv[2] === "collect" ? collect() : run());
process.exit(0);
