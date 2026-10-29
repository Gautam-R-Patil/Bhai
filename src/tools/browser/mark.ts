// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// browser_mark: Bhai points things out on the page the user is looking at —
// an orange box (and a short label) around each element, drawn in a layer that
// ignores the mouse. Nothing on the page is clicked or changed.

import type { ToolDefinition } from "../get-current-time.js";

export interface Mark {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    label?: string;
}

const MAX_MARKS = 10;

/** The in-page script. Marks go in as JSON data and labels as textContent, so neither can run code. */
export function buildMarkScript(marks: Mark[], clear: boolean): string {
    const data = JSON.stringify(
        marks.slice(0, MAX_MARKS).map((m) => ({
            selector: typeof m.selector === "string" ? m.selector.slice(0, 300) : "",
            text: typeof m.text === "string" ? m.text.slice(0, 200) : "",
            x: Number(m.x),
            y: Number(m.y),
            width: Number(m.width),
            height: Number(m.height),
            label: typeof m.label === "string" ? m.label.slice(0, 80) : "",
        })),
    );
    return `(() => {
  const ID = "__bhai_marks";
  document.getElementById(ID)?.remove();
  if (${clear ? "true" : "false"}) return { cleared: true };
  const marks = ${data};
  const layer = document.createElement("div");
  layer.id = ID;
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
  document.documentElement.appendChild(layer);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const byText = (t) => {
    const want = t.toLowerCase();
    let best = null;
    for (const el of document.body.querySelectorAll("*")) {
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) || !visible(el)) continue;
      if (!(el.innerText || "").toLowerCase().includes(want)) continue;
      if (!best || best.contains(el)) best = el; // keep the innermost match
    }
    return best;
  };
  const found = [], missing = [];
  marks.forEach((m, i) => {
    let rect = null, el = null;
    if (m.selector) { try { el = document.querySelector(m.selector); } catch {} }
    if (!el && m.text) el = byText(m.text);
    if (el && visible(el)) rect = el.getBoundingClientRect();
    else if ([m.x, m.y, m.width, m.height].every(Number.isFinite) && m.width > 0 && m.height > 0)
      rect = { left: m.x, top: m.y, width: m.width, height: m.height };
    if (!rect) { missing.push(m.label || m.selector || m.text || "mark " + (i + 1)); return; }
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;box-sizing:border-box;border:3px solid #f97316;border-radius:8px;box-shadow:0 0 0 4px rgba(249,115,22,.25);" +
      "left:" + (rect.left + scrollX - 4) + "px;top:" + (rect.top + scrollY - 4) + "px;width:" + (rect.width + 8) + "px;height:" + (rect.height + 8) + "px;";
    if (m.label) {
      const tag = document.createElement("div");
      tag.textContent = m.label;
      tag.style.cssText = "position:absolute;left:-3px;bottom:100%;margin-bottom:4px;background:#f97316;color:#fff;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;padding:2px 8px;border-radius:6px;white-space:nowrap;";
      box.appendChild(tag);
    }
    layer.appendChild(box);
    found.push({ el, rect });
  });
  const first = found[0];
  if (first && first.el) first.el.scrollIntoView({ block: "center", behavior: "smooth" });
  return { marked: found.length, missing };
})()`;
}

export const browserMark: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_mark",
            description:
                "Point things out to the user on the page they're looking at: draws an orange box, with an optional short label, " +
                "around each thing so they can see exactly what you mean. Use it when explaining a page, showing where to click, " +
                "or highlighting what you found. Mark by CSS selector, by visible text, or by x/y/width/height in viewport pixels " +
                "(e.g. from browser_scan). The marks stay until you call again with clear: true. It never clicks or changes the page.",
            parameters: {
                type: "object",
                properties: {
                    marks: {
                        type: "array",
                        maxItems: MAX_MARKS,
                        items: {
                            type: "object",
                            properties: {
                                selector: { type: "string", description: "CSS selector of the element" },
                                text: {
                                    type: "string",
                                    description: "Visible text inside the element (used if no selector matches)",
                                },
                                x: { type: "number" },
                                y: { type: "number" },
                                width: { type: "number" },
                                height: { type: "number" },
                                label: {
                                    type: "string",
                                    description: "Short label shown on the box, e.g. 'Click here' or '1'",
                                },
                            },
                        },
                    },
                    clear: { type: "boolean", description: "Remove your marks from the page" },
                },
            },
        },
    },
    async handler(input) {
        const marks = Array.isArray(input.marks) ? (input.marks as Mark[]) : [];
        const clear = input.clear === true;
        if (!clear && !marks.length) return JSON.stringify({ error: "Give at least one mark, or clear: true." });
        try {
            // Loaded here: core.js reaches the tool registry, which imports this file.
            const { getActivePage } = await import("./core.js");
            const page = await getActivePage();
            const result = await page.evaluate(buildMarkScript(marks, clear));
            return JSON.stringify({ success: true, ...(result as object) });
        } catch (err) {
            return JSON.stringify({ error: `Couldn't mark the page: ${(err as Error).message}` });
        }
    },
};
