// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Per-slug strike accounting. Three strikes within `window` archives the slug.
//
// The rolling-window math is dead simple: every `record_strike()` appends a
// timestamp, then `count_in_window(window)` walks from the back of the deque
// and pops anything older than `now - window`. We never grow unbounded because
// `is_archived()` runs after every record and the supervisor stops calling in
// once it returns true.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

const ARCHIVE_THRESHOLD: usize = 3;

#[derive(Debug, Default)]
pub struct StrikeRecord {
    timestamps: VecDeque<Instant>,
}

impl StrikeRecord {
    pub fn new() -> Self {
        Self { timestamps: VecDeque::new() }
    }

    /// Append a strike at the current instant. Caller should follow this with
    /// `is_archived(window)` and act on the result.
    pub fn record_strike(&mut self) {
        self.timestamps.push_back(Instant::now());
    }

    /// Count strikes whose age is < `window`. Drops expired entries from the
    /// front of the deque as a side effect — bounded growth.
    pub fn count_in_window(&mut self, window: Duration) -> usize {
        let cutoff = match Instant::now().checked_sub(window) {
            Some(c) => c,
            None => return self.timestamps.len(),
        };
        while let Some(front) = self.timestamps.front() {
            if *front < cutoff {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }
        self.timestamps.len()
    }

    /// `true` when count_in_window reaches the 3-strike archive threshold.
    pub fn is_archived(&mut self, window: Duration) -> bool {
        self.count_in_window(window) >= ARCHIVE_THRESHOLD
    }

    /// Reset to empty. Called from `StrikeBoard::clear` on user-revoke.
    pub fn clear(&mut self) {
        self.timestamps.clear();
    }
}

// StrikeBoard is filled in P2T4 — keeping the export stub line so the
// re-export in mod.rs continues to resolve.
pub struct StrikeBoard;

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn empty_record_is_not_archived() {
        let mut r = StrikeRecord::new();
        assert_eq!(r.count_in_window(Duration::from_secs(3600)), 0);
        assert!(!r.is_archived(Duration::from_secs(3600)));
    }

    #[test]
    fn two_strikes_in_window_is_not_archived() {
        let mut r = StrikeRecord::new();
        r.record_strike();
        r.record_strike();
        assert_eq!(r.count_in_window(Duration::from_secs(3600)), 2);
        assert!(!r.is_archived(Duration::from_secs(3600)));
    }

    #[test]
    fn three_strikes_in_window_is_archived() {
        let mut r = StrikeRecord::new();
        r.record_strike();
        r.record_strike();
        r.record_strike();
        assert_eq!(r.count_in_window(Duration::from_secs(3600)), 3);
        assert!(r.is_archived(Duration::from_secs(3600)));
    }

    #[test]
    fn old_strikes_drop_out_of_window() {
        let mut r = StrikeRecord::new();
        r.record_strike();
        sleep(Duration::from_millis(50));
        let count = r.count_in_window(Duration::from_millis(10));
        assert_eq!(count, 0, "expected expired strike to drop, got {count}");
        assert!(!r.is_archived(Duration::from_millis(10)));
    }

    #[test]
    fn count_drains_expired_strikes_from_deque() {
        let mut r = StrikeRecord::new();
        r.record_strike();
        r.record_strike();
        sleep(Duration::from_millis(30));
        r.record_strike();
        let count = r.count_in_window(Duration::from_millis(5));
        assert_eq!(count, 1, "expected one surviving strike, got {count}");
        assert_eq!(r.timestamps.len(), 1, "expected internal deque drained");
    }

    #[test]
    fn clear_resets_state() {
        let mut r = StrikeRecord::new();
        r.record_strike();
        r.record_strike();
        r.record_strike();
        assert!(r.is_archived(Duration::from_secs(3600)));
        r.clear();
        assert!(!r.is_archived(Duration::from_secs(3600)));
        assert_eq!(r.count_in_window(Duration::from_secs(3600)), 0);
    }
}
