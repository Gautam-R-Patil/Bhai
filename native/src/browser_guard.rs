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
    "grecaptcha.execute",
    "g-recaptcha-response",
    "recaptcha/api2/reload",
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
    "accept.*cookie", "cookie.*accept", "consent.*banner",
    "data-cc", // cookieconsent v3
];

const MODAL_SIGNALS: &[&str] = &[
    "exit-intent", "exit_intent", "newsletter-popup", "email-capture",
    "subscribe-modal", "lead-capture", "popup-overlay",
    "modal-backdrop", "intercom-lightweight-app",
    "hubspot-messages", "drift-widget", "olark",
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
        run_guard_eagerly: cookie_prob > 0.3 || modal_prob > 0.3,
        signals,
    }
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
