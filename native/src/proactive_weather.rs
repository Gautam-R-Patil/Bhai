// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Proactive V3 — weather actionability rules.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct WeatherInput {
    pub summary: String,
    pub temp_c: f64,
    pub rain_prob: f64,
    pub has_outdoor_event: bool,
}

#[napi]
pub fn weather_actionable(w: WeatherInput) -> bool {
    w.has_outdoor_event || w.rain_prob > 0.3 || w.temp_c < 10.0 || w.temp_c > 38.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(rain: f64, temp: f64, outdoor: bool) -> WeatherInput {
        WeatherInput {
            summary: "x".into(),
            temp_c: temp,
            rain_prob: rain,
            has_outdoor_event: outdoor,
        }
    }

    #[test]
    fn outdoor_event_is_actionable() {
        assert!(weather_actionable(mk(0.1, 22.0, true)));
    }
    #[test]
    fn rain_over_30_percent_actionable() {
        assert!(weather_actionable(mk(0.4, 22.0, false)));
    }
    #[test]
    fn cold_below_10c_actionable() {
        assert!(weather_actionable(mk(0.1, 5.0, false)));
    }
    #[test]
    fn hot_above_38c_actionable() {
        assert!(weather_actionable(mk(0.1, 40.0, false)));
    }
    #[test]
    fn mild_indoor_clear_not_actionable() {
        assert!(!weather_actionable(mk(0.1, 22.0, false)));
    }
}
