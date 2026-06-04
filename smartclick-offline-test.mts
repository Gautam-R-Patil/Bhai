// Offline test for os_smart_click — exercises activation + window-scoped capture
// + the local perception cascade (AX/OmniParser/UI-TARS) + real click dispatch.
// NO agent loop, NO cloud LLM needed (cloud_grounding tier skipped without an
// injected llm). Verifies the focus/window-scope fixes and click accuracy.
//
// Run: npx tsx smartclick-offline-test.mts "Downloads folder in the Finder sidebar" Finder

import { osSmartClick } from "./src/tools/os-smart-click.js";

const instruction = process.argv[2] || "the Downloads folder in the Finder left sidebar";
const app = process.argv[3] || "Finder";

console.log(`\n=== os_smart_click offline test ===`);
console.log(`instruction: "${instruction}"  app: ${app}\n`);

const t0 = Date.now();
const raw = await osSmartClick.handler({ instruction, app, action: "click" });
const elapsed = Date.now() - t0;

let parsed: Record<string, unknown>;
try { parsed = JSON.parse(raw as string); } catch { parsed = { raw }; }

console.log(`elapsed: ${elapsed}ms`);
console.log(`success: ${parsed.success}`);
console.log(`source (grounding tier): ${parsed.source}`);
console.log(`confidence: ${parsed.confidence}`);
console.log(`clicked: ${JSON.stringify(parsed.clicked)}`);
if (parsed.target) {
  const tg = parsed.target as Record<string, unknown>;
  console.log(`tried tiers: ${JSON.stringify(tg.triedTiers)}`);
  console.log(`per-tier ms: ${JSON.stringify(tg.elapsedMsByTier)}`);
  console.log(`reasoning: ${tg.reasoning ?? "(none)"}`);
}
if (parsed.error) console.log(`error: ${parsed.error}`);
if (parsed.tip) console.log(`tip: ${parsed.tip}`);
console.log("");
