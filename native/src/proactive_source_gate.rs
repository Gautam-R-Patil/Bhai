// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Proactive V3 — per-source last-run latch to prevent 30s-sweep storms.

use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct GateResult {
    pub may_run: bool,
    pub next_eligible_ms: f64,
}

static GATE_STATE: Lazy<Arc<Mutex<HashMap<String, f64>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[napi]
pub fn source_gate_check(source: String, min_gap_sec: u32) -> GateResult {
    let mut st = GATE_STATE.lock();
    let now = now_ms();
    let last = *st.get(&source).unwrap_or(&0.0);
    let gap = now - last;
    let min = (min_gap_sec as f64) * 1000.0;
    if gap >= min {
        st.insert(source, now);
        GateResult {
            may_run: true,
            next_eligible_ms: now + min,
        }
    } else {
        GateResult {
            may_run: false,
            next_eligible_ms: last + min,
        }
    }
}

#[napi]
pub fn source_gate_reset(source: String) {
    GATE_STATE.lock().remove(&source);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_call_runs() {
        source_gate_reset("t_a".into());
        let r = source_gate_check("t_a".into(), 60);
        assert!(r.may_run);
    }

    #[test]
    fn second_call_within_gap_blocked() {
        source_gate_reset("t_b".into());
        let _ = source_gate_check("t_b".into(), 60);
        let r = source_gate_check("t_b".into(), 60);
        assert!(!r.may_run);
    }

    #[test]
    fn reset_clears_latch() {
        source_gate_reset("t_c".into());
        let _ = source_gate_check("t_c".into(), 60);
        source_gate_reset("t_c".into());
        let r = source_gate_check("t_c".into(), 60);
        assert!(r.may_run);
    }
}
