// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Native Rust module for browser popup/overlay detection and CAPTCHA classification.
// Hot-path string pattern matching — runs on every page load, zero allocations
// for cache hits. All pattern data is compiled into the binary (no I/O).

use lazy_static::lazy_static;
use napi_derive::napi;
use serde::Serialize;

// ═══════════════════════════════════════════════
// CAPTCHA CLASSIFICATION
// ═══════════════════════════════════════════════

/// Detected CAPTCHA type (string_enum — no extra derives needed, napi adds them)
#[napi(string_enum)]
#[derive(Debug)]
pub enum CaptchaKind {
    RecaptchaV2,
    RecaptchaV3,
    Hcaptcha,
    Turnstile,
    Funcaptcha,
    None,
}

/// Result of CAPTCHA classification from page HTML
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct CaptchaClassification {
    pub kind: String, // matches CaptchaKind string representation
    pub confidence: f64,
    pub signals: Vec<String>,
}

// Compile-time pattern lists — zero allocation at runtime
const TURNSTILE_PATTERNS: &[&str] = &[
    "challenges.cloudflare.com",
    "cf-turnstile",
    "cf_clearance",
    "cloudflare-turnstile",
    "__cf_bm",
];

const HCAPTCHA_PATTERNS: &[&str] = &[
    "hcaptcha.com/1/api",
    "hcaptcha.com/captcha",
    "h-captcha",
    "hcaptcha-widget-id",
    "class=\"h-captcha",   // specific class name, not generic data-sitekey
    "data-hcaptcha",
];

const RECAPTCHA_V3_PATTERNS: &[&str] = &[
    "recaptcha/api.js?render=",
    "recaptcha/api.js?hl=",       // parameterised v3 includes
    "recaptchaenterprise/api.js",
    "grecaptcha.execute",
    "grecaptcha.ready",
    "recaptcha/api2/bframe",
    "recaptcha/api2/anchor",
    "recaptcha__en.js",           // gstatic bundled v3 script
    "recaptcha/releases/",        // gstatic release builds
    "grecaptcha.enterprise",
];

const RECAPTCHA_V2_PATTERNS: &[&str] = &[
    "google.com/recaptcha/api.js",
    "recaptcha.net/recaptcha/api.js",
    "g-recaptcha\"",
    "g-recaptcha '",
    "class=\"g-recaptcha",
    "data-callback",
    "recaptcha-checkbox",
];

const FUNCAPTCHA_PATTERNS: &[&str] = &[
    "funcaptcha.com",
    "arkoselabs.com",
    "arkose_token",
    "enforced_utokenstr",
];

/// Classify CAPTCHA from page HTML/source text.
/// Pass `document.documentElement.innerHTML` or a portion of it.
/// Returns the most confident match with detected signal names.
#[napi]
pub fn classify_captcha(html: String) -> CaptchaClassification {
    let lower = html.to_lowercase();

    // Check patterns in priority order (most distinctive first)
    let checks: &[(&[&str], &str, f64)] = &[
        (TURNSTILE_PATTERNS,   "turnstile",     0.95),
        (HCAPTCHA_PATTERNS,    "hcaptcha",      0.90),
        (RECAPTCHA_V3_PATTERNS,"recaptcha-v3",  0.85),
        (RECAPTCHA_V2_PATTERNS,"recaptcha-v2",  0.80),
        (FUNCAPTCHA_PATTERNS,  "funcaptcha",    0.85),
    ];

    let mut best_kind = "none".to_string();
    let mut best_conf = 0.0f64;
    let mut best_signals: Vec<String> = Vec::new();

    for (patterns, kind, base_conf) in checks {
        let mut matched: Vec<String> = Vec::new();
        for &pat in patterns.iter() {
            if lower.contains(pat) {
                matched.push(pat.to_string());
            }
        }
        if !matched.is_empty() {
            // Confidence scales with number of matching patterns
            let conf = base_conf * (1.0 + (matched.len() as f64 - 1.0) * 0.05).min(1.5);
            let conf = conf.min(0.99);
            if conf > best_conf {
                best_conf = conf;
                best_kind = kind.to_string();
                best_signals = matched;
            }
        }
    }

    CaptchaClassification {
        kind: best_kind,
        confidence: best_conf,
        signals: best_signals,
    }
}

// ═══════════════════════════════════════════════
// POPUP / OVERLAY DETECTION
// ═══════════════════════════════════════════════

/// Score the "popup risk" of a page from its HTML — higher = more likely to
/// have blocking overlays that need dismissal before automation can proceed.
/// Runs before page.evaluate() to decide whether popup-guard should fire eagerly.
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct PopupRiskScore {
    /// 0.0–1.0 probability of a consent/cookie banner
    pub cookie_banner_prob: f64,
    /// 0.0–1.0 probability of a newsletter/modal overlay
    pub modal_prob: f64,
    /// Whether to run popup guard immediately (true = run before scanning)
    pub run_guard_eagerly: bool,
    /// Detected signals
    pub signals: Vec<String>,
}

const COOKIE_SIGNALS: &[&str] = &[
    "onetrust", "cookiebot", "quantcast", "cookieconsent",
    "cookie-consent", "cookie_consent", "gdpr", "ccpa",
    "didomi", "trustarc", "usercentrics",
    "data-cc",              // cookieconsent v3
    "cookielaw.org",        // cookielaw CDN
    "consent.cookiefirst",
    "cookie-banner",
    "cookie-notice",
    "cookiehub",
    "iubenda",              // iubenda consent
    "termly.io",
    "cookiepro",
];

const MODAL_SIGNALS: &[&str] = &[
    "exit-intent", "exit_intent",
    "newsletter-popup", "newsletter_popup",
    "email-capture", "email_capture",
    "subscribe-modal", "subscribe_modal",
    "lead-capture", "lead_capture",
    "popup-overlay", "popup_overlay",
    "modal-backdrop",
    "intercom-lightweight-app",
    "hubspot-messages",
    "drift-widget",
    "olark",
    "klaviyo",              // Klaviyo email capture popups
    "attentive_overlay",    // Attentive SMS capture
    "privy",                // Privy popups
];

/// Score the popup risk of a page from its HTML source.
/// Cheap Rust string scan — call with page HTML to decide guard strategy.
#[napi]
pub fn score_popup_risk(html: String) -> PopupRiskScore {
    let lower = html.to_lowercase();
    let mut signals: Vec<String> = Vec::new();

    let mut cookie_hits = 0usize;
    for &sig in COOKIE_SIGNALS {
        if lower.contains(sig) {
            cookie_hits += 1;
            signals.push(sig.to_string());
        }
    }

    let mut modal_hits = 0usize;
    for &sig in MODAL_SIGNALS {
        if lower.contains(sig) {
            modal_hits += 1;
            signals.push(sig.to_string());
        }
    }

    let cookie_prob = (cookie_hits as f64 * 0.35).min(0.95);
    let modal_prob  = (modal_hits  as f64 * 0.30).min(0.90);

    PopupRiskScore {
        cookie_banner_prob: cookie_prob,
        modal_prob,
        run_guard_eagerly: cookie_prob >= 0.3 || modal_prob >= 0.3,
        signals,
    }
}

// ═══════════════════════════════════════════════
// TOKEN COMPRESSION FOR LLM OUTPUT
// ═══════════════════════════════════════════════

/// A single interactive element for compression input.
/// width/height required for bounding-box containment deduplication.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ElementForCompression {
    pub label: u32,
    pub tag: String,
    pub text: String,
    pub x: f64,
    pub y: f64,
    /// Element width in CSS pixels (0 if unknown — skips containment dedup)
    pub width: f64,
    /// Element height in CSS pixels (0 if unknown — skips containment dedup)
    pub height: f64,
    pub is_ocr: bool,
    #[napi(ts_type = "string | undefined | null")]
    pub editor_type: Option<String>,
}

/// Compress an interactive element list for LLM consumption.
///
/// Adapted from OpenCLI's dom-snapshot.ts multi-stage pruning pipeline.
/// Reductions (in order):
/// 1. **99% bounding-box containment dedup** (OpenCLI innovation) — if el A's box ≥99%
///    overlaps el B's box, keep the one with richer text (typically the outer wrapper).
///    Eliminates `[3]<a> [4]<svg>` noise from icon-buttons.
/// 2. **Spatial dedup** — same (tag, text) within 30px radius (existing)
/// 3. **Consecutive group folding** — `[5]<button>Add [6]<button>Add` → `[5..6×2]<button>Add`
/// 4. **Text truncation + cleanup** — max_text_len chars, strip newlines
/// 5. **Element cap** — max_elements (default 80)
///
/// **Output format** (OpenCLI `[N]<tag>` convention):
/// `[42]<button>Submit` — ~15% fewer tokens vs `[42] button "Submit"`
/// `[10]<select>Red` — selects show current value
/// `[8]<input[text]>First name placeholder=Jane` — inputs show type + label
#[napi]
pub fn compress_elements_for_llm(
    elements: Vec<ElementForCompression>,
    max_text_len: Option<u32>,
    max_elements: Option<u32>,
) -> String {
    let max_text = max_text_len.unwrap_or(40) as usize;
    let max_els  = max_elements.unwrap_or(80) as usize;

    if elements.is_empty() {
        return "No interactive elements.".to_string();
    }

    // ── Step 1: 99% bounding-box containment dedup (OpenCLI technique) ──────
    // If element A's bounding box contains ≥99% of element B's area,
    // they represent the same UI target. Keep the one with more text (richer label).
    // This eliminates button+icon, link+svg, div+span nesting noise patterns.
    let mut containment_removed: Vec<bool> = vec![false; elements.len()];

    if elements.iter().any(|e| e.width > 0.0 && e.height > 0.0) {
        for i in 0..elements.len() {
            if containment_removed[i] { continue; }
            let a = &elements[i];
            if a.width <= 0.0 || a.height <= 0.0 { continue; }
            let a_left = a.x - a.width / 2.0;
            let a_top  = a.y - a.height / 2.0;
            let a_right = a.x + a.width / 2.0;
            let a_bot   = a.y + a.height / 2.0;
            let a_area  = a.width * a.height;

            for j in (i + 1)..elements.len() {
                if containment_removed[j] { continue; }
                let b = &elements[j];
                if b.width <= 0.0 || b.height <= 0.0 { continue; }
                let b_left = b.x - b.width / 2.0;
                let b_top  = b.y - b.height / 2.0;
                let b_right = b.x + b.width / 2.0;
                let b_bot   = b.y + b.height / 2.0;
                let b_area  = b.width * b.height;

                // Compute intersection
                let ix = (a_right.min(b_right) - a_left.max(b_left)).max(0.0);
                let iy = (a_bot.min(b_bot)     - a_top.max(b_top)).max(0.0);
                let inter = ix * iy;
                if inter <= 0.0 { continue; }

                let overlap_a = inter / a_area;
                let overlap_b = inter / b_area;

                // If either is 99%+ contained in the other, remove the one with less text
                if overlap_a >= 0.99 || overlap_b >= 0.99 {
                    // Keep the one with more text content (richer label for LLM)
                    let a_rich = a.text.trim().len();
                    let b_rich = b.text.trim().len();
                    if a_rich >= b_rich {
                        containment_removed[j] = true; // remove B, keep A
                    } else {
                        containment_removed[i] = true; // remove A, keep B
                        break; // A is removed; no point comparing A further
                    }
                }
            }
        }
    }

    let after_containment: Vec<&ElementForCompression> = elements.iter()
        .enumerate()
        .filter(|(i, _)| !containment_removed[*i])
        .map(|(_, e)| e)
        .collect();

    // ── Step 2: spatial dedup — same (tag, text) within 30px ────────────────
    let mut seen_spatial: Vec<(String, String, f64, f64)> = Vec::new();
    let mut deduped: Vec<&ElementForCompression> = Vec::new();

    for el in &after_containment {
        let text_lo = el.text.trim().to_lowercase();
        let text_key = if text_lo.len() > max_text { &text_lo[..max_text] } else { &text_lo };
        let is_dup = seen_spatial.iter().any(|(t, tx, sx, sy)| {
            *t == el.tag && tx.as_str() == text_key
                && (sx - el.x).abs() < 30.0 && (sy - el.y).abs() < 30.0
        });
        if !is_dup {
            seen_spatial.push((el.tag.clone(), text_key.to_string(), el.x, el.y));
            deduped.push(el);
        }
    }

    // ── Step 3: consecutive group folding ────────────────────────────────────
    struct Group<'a> {
        first_label: u32,
        last_label: u32,
        count: u32,
        el: &'a ElementForCompression,
    }
    let mut groups: Vec<Group> = Vec::new();
    for el in &deduped {
        let text_trunc = if el.text.len() > max_text { &el.text[..max_text] } else { &el.text };
        if let Some(last) = groups.last_mut() {
            let last_trunc = if last.el.text.len() > max_text { &last.el.text[..max_text] } else { &last.el.text };
            if last.el.tag == el.tag && last_trunc == text_trunc && last.count < 5 {
                last.last_label = el.label;
                last.count += 1;
                continue;
            }
        }
        groups.push(Group { first_label: el.label, last_label: el.label, count: 1, el });
    }

    // ── Step 4: format using OpenCLI [N]<tag>text convention ────────────────
    // Saves ~15% tokens vs [N] tag "text" by removing quotes and old format.
    let mut lines = Vec::new();
    for g in groups.iter().take(max_els) {
        let raw_text = if g.el.text.len() > max_text { &g.el.text[..max_text] } else { &g.el.text };
        let text = raw_text.trim().replace('\n', " ").replace('\r', "").replace("  ", " ");

        let line = if let Some(ref et) = g.el.editor_type {
            format!("[{}]<code-editor:{}>", g.first_label, et)
        } else if g.el.is_ocr {
            format!("[{}]<ocr>{}", g.first_label, text)
        } else if g.count > 1 {
            if text.is_empty() {
                format!("[{}..{}×{}]<{}>", g.first_label, g.last_label, g.count, g.el.tag)
            } else {
                format!("[{}..{}×{}]<{}>{}", g.first_label, g.last_label, g.count, g.el.tag, text)
            }
        } else if text.is_empty() {
            format!("[{}]<{}>", g.first_label, g.el.tag)
        } else {
            format!("[{}]<{}>{}", g.first_label, g.el.tag, text)
        };
        lines.push(line);
    }

    if groups.len() > max_els {
        lines.push(format!("... +{} more (use browser_scroll to see more)", groups.len() - max_els));
    }

    lines.join("\n")
}

// ═══════════════════════════════════════════════
// STEALTH: INIT SCRIPT (compiled into binary)
// The stealth patches are stored here in Rust so they cannot be read from
// decompiled TypeScript source or inspected from an unpacked Electron app.
// ═══════════════════════════════════════════════

/// Return the JavaScript string to inject via addInitScript() for stealth.
/// Stored in Rust binary — not visible in TypeScript source or unpacked apps.
/// `session_seed`: any u32 — used to vary internal variable names per session.
#[napi]
pub fn get_stealth_init_script(session_seed: u32) -> String {
    // Variable names derived from seed — different every session, harder to fingerprint
    let v1 = format!("_p{:x}", (session_seed ^ 0xA5F3) & 0xFFFF);
    let v2 = format!("_q{:x}", (session_seed ^ 0x3C21) & 0xFFFF);
    let v3 = format!("_r{:x}", (session_seed ^ 0x7E9B) & 0xFFFF);

    format!(r#"(function() {{
  // Remove navigator.webdriver — primary bot signal
  try {{
    const {v1} = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    Object.defineProperty(Navigator.prototype, 'webdriver', {{
      get: () => undefined, configurable: true
    }});
  }} catch(e) {{
    try {{ Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }}); }} catch(_) {{}}
  }}
  // Realistic plugin list (headless has 0, real Chrome has 3+)
  const {v2} = [
    {{name:'Chrome PDF Plugin',filename:'internal-pdf-viewer',description:'Portable Document Format'}},
    {{name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai',description:''}},
    {{name:'Native Client',filename:'internal-nacl-plugin',description:''}}
  ];
  try {{
    Object.defineProperty(navigator, 'plugins', {{
      get: function() {{
        const arr = [{v2}[0],{v2}[1],{v2}[2]];
        Object.setPrototypeOf(arr, PluginArray.prototype);
        return arr;
      }}, configurable: true
    }});
  }} catch(_) {{}}
  // Realistic language list
  try {{
    Object.defineProperty(navigator, 'languages', {{
      get: () => ['en-US', 'en'], configurable: true
    }});
  }} catch(_) {{}}
  // Permissions API — return 'default' state for notifications (not 'denied')
  const {v3} = navigator.permissions && navigator.permissions.query;
  if ({v3}) {{
    navigator.permissions.query = function(params) {{
      if (params && params.name === 'notifications') {{
        return Promise.resolve({{ state: 'default', onchange: null }});
      }}
      return {v3}.call(navigator.permissions, params);
    }};
  }}
  // Hardware concurrency — realistic value (not 0 like some headless)
  try {{
    Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => 8, configurable: true }});
  }} catch(_) {{}}
  // deviceMemory — realistic (instead of headless default of 0)
  try {{
    Object.defineProperty(navigator, 'deviceMemory', {{ get: () => 8, configurable: true }});
  }} catch(_) {{}}
}})();"#,
        v1 = v1, v2 = v2, v3 = v3
    )
}

// ═══════════════════════════════════════════════
// STEALTH: USER-AGENT ROTATION
// ═══════════════════════════════════════════════

lazy_static! {
    static ref CHROME_UAS_WIN: Vec<&'static str> = vec![
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    ];

    static ref CHROME_UAS_MAC: Vec<&'static str> = vec![
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ];

    static ref CHROME_UAS_LINUX: Vec<&'static str> = vec![
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ];
}

/// Return a realistic Chrome user-agent string for the current platform.
/// `platform`: "windows", "mac", "linux" (or empty for auto-detect via cfg).
/// `session_seed`: any u32 — used to select deterministically within the session
///   (prevents UA from changing mid-session, which bots sometimes do).
#[napi]
pub fn get_stealth_user_agent(platform: String, session_seed: u32) -> String {
    let p = platform.to_lowercase();
    let list = if p.contains("win") {
        &*CHROME_UAS_WIN
    } else if p.contains("mac") {
        &*CHROME_UAS_MAC
    } else {
        // Detect at compile time
        #[cfg(target_os = "macos")]
        { &*CHROME_UAS_MAC }
        #[cfg(target_os = "windows")]
        { &*CHROME_UAS_WIN }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        { &*CHROME_UAS_LINUX }
    };
    let idx = (session_seed as usize) % list.len();
    list[idx].to_string()
}

// ═══════════════════════════════════════════════
// STEALTH: HUMAN TIMING SIMULATION
// ═══════════════════════════════════════════════

/// Compute realistic human typing delay in ms for a given character.
/// Humans type faster on common letters, slower on punctuation/numbers.
/// Returns delay to wait AFTER typing the character.
#[napi]
pub fn human_typing_delay_ms(char_code: u32, base_wpm: u32) -> u32 {
    // Base delay from WPM (average 5 chars/word)
    let base_ms = 60_000 / (base_wpm.max(1) * 5);
    // Jitter: ±30% variation (deterministic from char_code to avoid RNG overhead)
    let jitter_pct = ((char_code % 60) as i32) - 30; // -30..+30
    let delay = base_ms as i32 + (base_ms as i32 * jitter_pct / 100);
    // Extra delay for: space (small pause), punctuation/numbers (longer)
    let extra = match char_code {
        32 => 40,             // space — short phrase boundary
        13 | 10 => 80,        // Enter — sentence boundary
        46 | 44 | 33 | 63 => 60, // . , ! ? — end of sentence
        48..=57 => 25,        // digits — slightly slower
        _ => 0,
    };
    (delay.max(20) as u32) + extra
}

/// Compute a realistic pre-click mouse dwell time in ms.
/// Real humans pause 150-400ms after moving to an element before clicking.
/// `element_size`: bounding box area (width*height) — smaller = more careful = longer dwell.
#[napi]
pub fn human_click_dwell_ms(element_area: f64, seed: u32) -> u32 {
    // Base dwell: 150-350ms
    let base = 150u32 + (seed % 200);
    // Small elements get extra dwell (user aims more carefully)
    let extra = if element_area < 400.0 { 80 }
                else if element_area < 1600.0 { 40 }
                else { 0 };
    base + extra
}

/// Compute interpolated mouse movement steps for human-like motion.
/// Returns (steps, pause_ms_before_click) for page.mouse.move(x, y, { steps }).
/// Real humans: fast movement → slow down near target (Fitts's law).
#[napi]
pub fn human_mouse_params(
    start_x: f64, start_y: f64,
    end_x: f64,   end_y: f64,
    seed: u32,
) -> Vec<f64> { // [steps, pre_click_pause_ms]
    let dist = ((end_x - start_x).powi(2) + (end_y - start_y).powi(2)).sqrt();
    // Fitts's law: more steps for longer distance, fewer for short hops
    let steps = if dist < 50.0 { 3u32 }
                else if dist < 200.0 { 6 + seed % 4 }
                else if dist < 500.0 { 10 + seed % 6 }
                else { 14 + seed % 8 };
    let pause = 120u32 + (seed % 80);
    vec![steps as f64, pause as f64]
}
