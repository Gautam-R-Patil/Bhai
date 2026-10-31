// End-to-end verification of all changes made this session, on the real macOS system.
// Tests accuracy + speed. Run: npx tsx verify-all.mts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const results: Array<{ name: string; pass: boolean; detail: string; ms?: number }> = [];
function rec(name: string, pass: boolean, detail: string, ms?: number) {
    results.push({ name, pass, detail, ms });
    const tag = pass ? "✅ PASS" : "❌ FAIL";
    console.log(`${tag} | ${name}${ms !== undefined ? ` (${ms}ms)` : ""} — ${detail}`);
}
async function activate(app: string) {
    try { await execFileAsync("osascript", ["-e", `tell application "${app}" to activate`], { timeout: 5000 }); } catch {}
    await new Promise((r) => setTimeout(r, 1800));
}
// Dump AX with retry until the tree is populated (mirrors the cascade's cold-window retry).
// A freshly-activated window often returns an incomplete tree on the first dump.
async function settledDump() {
    const { dumpAccessibilityTree, flattenInteractive } = await import("./src/screen/ax-dump.js");
    let dump = await dumpAccessibilityTree({ depth: 20 });
    for (let i = 0; i < 4; i++) {
        if (!dump.error && flattenInteractive(dump).length > 40) break;
        await new Promise((r) => setTimeout(r, 500));
        dump = await dumpAccessibilityTree({ depth: 20 });
    }
    return dump;
}

// ── 1. KEYSTONE: getScriptsDir resolves + AX dump runs ──
{
    const { getScriptsDir, resolveScript } = await import("./src/config/paths.js");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sdir = getScriptsDir();
    const binOk = existsSync(join(sdir, "dump_ax_bin"));
    rec("paths.getScriptsDir finds dump_ax_bin", binOk, `scriptsDir=${sdir}`);
    rec("paths.resolveScript('dump_ax_bin')", resolveScript("dump_ax_bin") !== null, `→ ${resolveScript("dump_ax_bin")}`);
}

// ── 2. AX dump + label extraction (the accuracy fix) ──
await activate("Finder");
{
    const { flattenInteractive, findElementByLabel } = await import("./src/screen/ax-dump.js");
    const t0 = Date.now();
    const dump = await settledDump();
    const dumpMs = Date.now() - t0;
    if (dump.error) {
        rec("AX dump (Finder)", false, `dump error: ${dump.error}`, dumpMs);
    } else {
        const els = flattenInteractive(dump);
        const labeled = els.filter((e) => (e.label || "").trim());
        rec("AX dump returns labeled elements", labeled.length > 10, `${els.length} els, ${labeled.length} labeled`, dumpMs);
        // Accuracy: descriptive instruction must match the real short label
        const m = findElementByLabel(els, "the Downloads folder in the sidebar", 0.8);
        rec("AX matches descriptive→short label (Downloads)", !!m && /download/i.test(m.label || ""), m ? `hit "${m.label}"` : "MISS");
    }
}

// ── 3. os_smart_click end-to-end: fast AX path, correct coord ──
{
    const { osSmartClick } = await import("./src/tools/os-smart-click.js");
    await activate("Finder");
    const t0 = Date.now();
    const raw = JSON.parse((await osSmartClick.handler({ instruction: "the Downloads folder in the sidebar", app: "Finder", action: "click" })) as string);
    const ms = Date.now() - t0;
    const fast = ms < 4000;
    const viaAx = typeof raw.source === "string" && raw.source.startsWith("ax");
    rec("smart_click Downloads: success", raw.success === true, `source=${raw.source} conf=${raw.confidence} clicked=${JSON.stringify(raw.clicked)}`, ms);
    rec("smart_click Downloads: FAST (<4s) via AX", fast && viaAx, `${ms}ms via ${raw.source} (was 49578ms via ui_tars)`, ms);
}

// ── 4. os_smart_click on a second app (System Settings) ──
{
    const { osSmartClick } = await import("./src/tools/os-smart-click.js");
    await execFileAsync("open", ["-a", "System Settings"]).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const t0 = Date.now();
    const raw = JSON.parse((await osSmartClick.handler({ instruction: "Wi-Fi in the sidebar", app: "System Settings", action: "click" })) as string);
    const ms = Date.now() - t0;
    rec("smart_click Wi-Fi (System Settings)", raw.success === true, `source=${raw.source} conf=${raw.confidence}`, ms);
}

// ── 5. Negative test: nonsense target must NOT false-click ──
{
    const { osSmartClick } = await import("./src/tools/os-smart-click.js");
    await activate("Finder");
    const raw = JSON.parse((await osSmartClick.handler({ instruction: "the nonexistent quux frobnicate zxcvb widget", app: "Finder", action: "click" })) as string);
    rec("smart_click negative: refuses bogus target", raw.success === false, raw.success === false ? `correctly refused (${raw.error})` : `WRONGLY clicked ${raw.source} ${JSON.stringify(raw.clicked)}`);
}

// ── 6. Input primitives: hold_key letters (game movement) ──
{
    const { osComputerAction: ca } = await import("./src/tools/os-computer-action.js");
    await activate("Finder");
    for (const k of ["w", "a", "s", "d", "up", "5"]) {
        const r = JSON.parse((await ca.handler({ action: "hold_key", text: k, durationMs: 80 })) as string);
        rec(`hold_key '${k}'`, r.success === true, r.success ? `held=${r.held}` : `error: ${r.error}`);
    }
    // It must still REJECT a genuinely bogus key
    const bad = JSON.parse((await ca.handler({ action: "hold_key", text: "notarealkey", durationMs: 50 })) as string);
    rec("hold_key rejects bogus key", bad.success === false, bad.success ? "WRONGLY accepted" : `correctly rejected: ${bad.error}`);
}

// ── 7. zoom: full-res crop, correct geometry ──
{
    const { osComputerAction: ca } = await import("./src/tools/os-computer-action.js");
    const t0 = Date.now();
    const r = JSON.parse((await ca.handler({ action: "zoom", region: [0.25, 0.25, 0.75, 0.75], coordSystem: "percent" })) as string);
    const ms = Date.now() - t0;
    const ok = r.success && typeof r.zoomed_base64 === "string" && r.zoomed_base64.length > 1000 && r.cropRegionPx?.width > 0;
    rec("zoom returns full-res crop", ok, ok ? `crop=${JSON.stringify(r.cropRegionPx)} b64len=${r.zoomed_base64.length}` : `error: ${r.error}`, ms);
}

// ── 8. real keystroke typing into TextEdit (accuracy: exact text lands, clipboard untouched) ──
{
    const { osComputerAction: ca } = await import("./src/tools/os-computer-action.js");
    // Seed clipboard with a sentinel so we can prove we did NOT clobber it
    const sentinel = "BHAI_CLIPBOARD_SENTINEL_123";
    await execFileAsync("osascript", ["-e", `set the clipboard to "${sentinel}"`], { timeout: 5000 });
    // Open a fresh TextEdit doc
    await execFileAsync("osascript", ["-e", 'tell application "TextEdit" to make new document'], { timeout: 8000 }).catch(() => {});
    await activate("TextEdit");
    const typed = "hello world 123";
    await ca.handler({ action: "type", text: typed });
    await new Promise((r) => setTimeout(r, 800));
    // Read back the document text
    let docText = "";
    try { const { stdout } = await execFileAsync("osascript", ["-e", 'tell application "TextEdit" to get text of front document'], { timeout: 5000 }); docText = stdout.trim(); } catch {}
    // Case-insensitive: TextEdit auto-capitalizes the first letter — not a typing bug.
    rec("type lands exact text (real keystrokes)", docText.toLowerCase().includes(typed.toLowerCase()), `doc="${docText.slice(0, 40)}"`);
    // Clipboard must be UNCHANGED (proves we used real keystrokes, not paste)
    let clip = "";
    try { const { stdout } = await execFileAsync("osascript", ["-e", "the clipboard as text"], { timeout: 5000 }); clip = stdout.trim(); } catch {}
    rec("type did NOT clobber clipboard", clip === sentinel, `clipboard="${clip}"`);
    // Cleanup: close TextEdit doc without saving
    await execFileAsync("osascript", ["-e", 'tell application "TextEdit" to close front document saving no'], { timeout: 5000 }).catch(() => {});
}

// ── 9. Blender cross-OS resolution + real bpy execution (accuracy: it actually runs a script) ──
{
    const { blenderScript } = await import("./src/tools/blender.js");
    const t0 = Date.now();
    const r = JSON.parse((await blenderScript.handler({
        script: "import bpy\nbpy.ops.mesh.primitive_cube_add(size=2)\nprint('BHAI_BLENDER_OK objects=' + str(len(bpy.data.objects)))",
        timeout: 60000,
    })) as string);
    const ms = Date.now() - t0;
    const ok = r.success === true && /BHAI_BLENDER_OK/.test(r.stdout || "");
    rec("blender_script runs bpy (cross-OS resolve)", ok, ok ? `stdout had marker; ${(r.stdout||"").match(/BHAI_BLENDER_OK[^\n]*/)?.[0]}` : `success=${r.success} err=${r.error}`, ms);
}

// ── SUMMARY ──
const pass = results.filter((r) => r.pass).length;
console.log(`\n========== ${pass}/${results.length} PASSED ==========`);
const fails = results.filter((r) => !r.pass);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log(`  ❌ ${f.name}: ${f.detail}`); }
