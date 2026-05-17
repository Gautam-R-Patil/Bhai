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

    /// Const-correct length probe — does NOT drain. Used by StrikeBoard
    /// pruning under a shared-ref closure.
    pub fn count_in_window_const(&self) -> usize {
        self.timestamps.len()
    }
}

// ─── StrikeBoard ─────────────────────────────────────────
//
// `DashMap<String, StrikeRecord>` keyed by slug. Lock-free reads, sharded
// per-key write lock so two unrelated slugs never contend.

use dashmap::DashMap;
use std::sync::Arc;

#[derive(Debug, Default, Clone)]
pub struct StrikeBoard {
    strikes: Arc<DashMap<String, StrikeRecord>>,
}

impl StrikeBoard {
    pub fn new() -> Self {
        Self { strikes: Arc::new(DashMap::new()) }
    }

    /// Record one strike against `slug`. Returns the current count within the
    /// 1-hour window. Caller decides whether the count crosses the archive
    /// threshold and what to do about it.
    pub fn record(&self, slug: &str, window: Duration) -> usize {
        let mut entry = self.strikes.entry(slug.to_string()).or_default();
        entry.record_strike();
        entry.count_in_window(window)
    }

    /// Read-only check — no mutation. Internally `is_archived` drains expired
    /// entries which IS a mutation, so we go through `entry` not `get`.
    pub fn is_archived(&self, slug: &str, window: Duration) -> bool {
        let mut entry = self.strikes.entry(slug.to_string()).or_default();
        entry.is_archived(window)
    }

    pub fn count(&self, slug: &str, window: Duration) -> usize {
        // Use a scoped block so the entry guard drops before we attempt the
        // remove(). DashMap's entry API holds a write lock on the shard;
        // removing without dropping deadlocks.
        let remaining = {
            let mut entry = self.strikes.entry(slug.to_string()).or_default();
            entry.count_in_window(window)
        };
        if remaining == 0 {
            // Prune empty entries so a "1 strike each on 10k slugs" attacker
            // can't pin unbounded VecDeques in the map. We rely on
            // count_in_window having already drained expired timestamps.
            self.strikes
                .remove_if(slug, |_, rec| rec.count_in_window_const() == 0);
        }
        remaining
    }

    /// Reset on user-revoke. Removes the slug entry entirely so the next
    /// strike starts fresh.
    pub fn clear(&self, slug: &str) {
        self.strikes.remove(slug);
    }
}

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

#[cfg(test)]
mod board_tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn board_records_per_slug_independently() {
        let board = StrikeBoard::new();
        let w = Duration::from_secs(3600);
        assert_eq!(board.record("a", w), 1);
        assert_eq!(board.record("a", w), 2);
        assert_eq!(board.record("b", w), 1);
        assert_eq!(board.count("a", w), 2);
        assert_eq!(board.count("b", w), 1);
        assert!(!board.is_archived("a", w));
        assert!(!board.is_archived("b", w));
    }

    #[test]
    fn board_archives_at_three() {
        let board = StrikeBoard::new();
        let w = Duration::from_secs(3600);
        board.record("evil", w);
        board.record("evil", w);
        assert!(!board.is_archived("evil", w));
        board.record("evil", w);
        assert!(board.is_archived("evil", w));
    }

    #[test]
    fn board_clear_resets_slug() {
        let board = StrikeBoard::new();
        let w = Duration::from_secs(3600);
        board.record("x", w);
        board.record("x", w);
        board.record("x", w);
        assert!(board.is_archived("x", w));
        board.clear("x");
        assert!(!board.is_archived("x", w));
        assert_eq!(board.count("x", w), 0);
    }

    #[test]
    fn board_unknown_slug_is_not_archived() {
        let board = StrikeBoard::new();
        let w = Duration::from_secs(3600);
        assert!(!board.is_archived("never_seen", w));
        assert_eq!(board.count("never_seen", w), 0);
    }

    #[test]
    fn board_drops_expired_strikes() {
        let board = StrikeBoard::new();
        board.record("flaky", Duration::from_secs(3600));
        board.record("flaky", Duration::from_secs(3600));
        sleep(Duration::from_millis(40));
        let count = board.count("flaky", Duration::from_millis(10));
        assert_eq!(count, 0, "expected 0 strikes in tight window, got {count}");
    }
}
