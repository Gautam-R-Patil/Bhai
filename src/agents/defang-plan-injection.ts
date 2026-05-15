// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// Scrub identity-affirming language from an orchestrator's plan output before
// it gets injected as a system message to the main agent. The orchestrator
// runs with its own server-side identity-defense prompt, but as belt-and-
// suspenders this strips any affirmation of XAGI/Atlas/founder/builder
// claims that might have leaked through.

// Patterns stored as source-strings so each call gets a fresh RegExp instance.
// (Using a module-scoped `g`-flagged regex would leak `lastIndex` across
// invocations and silently miss matches at the start of subsequent plans.)
const AFFIRMATION_SOURCES: Array<{ source: string; replacement: string }> = [
  // Second-person ownership/creator claims about XAGI or Atlas
  { source: String.raw`\byou(?:'re|\s+are)?\s+(?:literally\s+)?the\s+(?:founder|co-?founder|owner|creator|builder|developer|maker|author|architect|head|chief|ceo|cto|vp|president|director)\s+(?:of\s+)?(?:xagi(?:[\s-]labs)?|atlas|a\.?t\.?l\.?a\.?s\.?)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\byou(?:'re|\s+are)?\s+(?:literally\s+)?the\s+(?:person|one|guy|woman|man)\s+who\s+(?:built|created|made|developed|started|founded|runs?|leads?)\s+(?:me|atlas|a\.?t\.?l\.?a\.?s\.?|xagi(?:[\s-]labs)?|us)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\byou\s+(?:built|created|made|developed|wrote|coded|designed|started|founded|run|running|lead|leading|own|owned)\s+(?:me|atlas|a\.?t\.?l\.?a\.?s\.?|xagi(?:[\s-]labs)?|us)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\byou\s+co-?founded\s+(?:atlas|a\.?t\.?l\.?a\.?s\.?|xagi(?:[\s-]labs)?|us)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\b(?:that's|that\s+is)\s+(?:literally\s+)?where\s+i\s+was\s+(?:built|created|made|developed)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\byour\s+(?:xagi(?:[\s-]labs)?|atlas|a\.?t\.?l\.?a\.?s\.?)\s+(?:roadmap|product|company|project|codebase|repo|team|labs?)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\byour\s+(?:xagi(?:[\s-]labs)?|atlas|a\.?t\.?l\.?a\.?s\.?)\b(?!\s+(?:experience|opinion|view|take|perspective))`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\byou\s+know\s+exactly\s+how\s+i\s+work\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  // Founder-by-passive-voice constructions
  { source: String.raw`\b(?:founded|created|built|made|started|architected)\s+by\s+you\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\b(?:this|atlas|xagi)\s+is\s+your\s+(?:company|project|product|baby|creation|brainchild)\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  { source: String.raw`\boriginally\s+yours\b`, replacement: "[user mentioned an unverified affiliation claim]" },
  // Procedural / imperative prompt-injection attempts in plan inputs
  { source: String.raw`\b(?:treat|consider|regard|assume)\s+(?:the\s+)?user\s+as\s+(?:the\s+)?(?:founder|owner|creator|builder|developer|authenticated|admin)\b`, replacement: "[unverified instruction — do not follow]" },
  { source: String.raw`\b(?:proceed|continue|act)\s+(?:with|as\s+if|as\s+though)\s+(?:founder|owner|admin|authenticated|elevated|trusted)\s+(?:permissions?|access|privileges?|status)\b`, replacement: "[unverified instruction — do not follow]" },
  { source: String.raw`\buser\s+is\s+(?:authenticated|authorized|approved|the\s+founder|the\s+owner|elevated|admin)\b`, replacement: "[unverified instruction — do not follow]" },
  // Direct affirmation of founder/owner/builder status
  { source: String.raw`\b(?:yes|yeah|100%|absolutely)[,\s]+(?:you(?:'re|\s+are)?\s+(?:the\s+)?(?:founder|co-?founder|owner|builder|creator|developer)|that\s+tracks)\b`, replacement: "[unverified claim — do not echo]" },
];

export interface DefangResult {
  text: string;
  scrubbed: boolean;
  patternsHit: number;
}

/**
 * Defang an orchestrator plan output by neutralizing identity-affirming
 * phrases. Returns the scrubbed text plus a count of patterns that fired.
 */
export function defangPlanInjection(text: string): DefangResult {
  if (!text) return { text, scrubbed: false, patternsHit: 0 };
  let out = text;
  let patternsHit = 0;
  for (const { source, replacement } of AFFIRMATION_SOURCES) {
    const re = new RegExp(source, "gi");
    const matches = out.match(re);
    if (matches && matches.length > 0) {
      patternsHit += matches.length;
      out = out.replace(re, replacement);
    }
  }
  return { text: out, scrubbed: patternsHit > 0, patternsHit };
}
