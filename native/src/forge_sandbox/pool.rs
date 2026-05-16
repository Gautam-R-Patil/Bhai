// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// LRU-bounded per-slug worker pool. The Pool's only knob is `cap`; eviction
// is automatic, and inflight workers are skipped during eviction so a slow
// call never gets its child killed out from under it.
//
// The lock is a `tokio::sync::Mutex` (NOT parking_lot) because we hold the
// guard across `.await` points when invoking through a worker. parking_lot's
// mutex isn't async-aware and would deadlock the runtime.

use crate::forge_sandbox::worker::{InvokeError, Sandpath, Worker};
use crate::forge_sandbox::{Capabilities, Sandbox};
use lru::LruCache;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug)]
pub enum SpawnError {
    Io(std::io::Error),
    Boot(InvokeError),
    NoCapacity,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::Io(e) => write!(f, "spawn io: {e}"),
            SpawnError::Boot(e) => write!(f, "spawn boot: {e}"),
            SpawnError::NoCapacity => write!(f, "spawn: pool at capacity with all-inflight"),
        }
    }
}

impl std::error::Error for SpawnError {}

pub struct Pool {
    sandbox: Box<dyn Sandbox>,
    inner: Mutex<LruCache<String, Worker>>,
}

impl Pool {
    pub fn new(sandbox: Box<dyn Sandbox>, cap: usize) -> Self {
        let nz = NonZeroUsize::new(cap.max(1)).expect("cap >= 1");
        Self {
            sandbox,
            inner: Mutex::new(LruCache::new(nz)),
        }
    }

    pub async fn set_cap(&self, cap: usize) {
        let nz = NonZeroUsize::new(cap.max(1)).expect("cap >= 1");
        let mut guard = self.inner.lock().await;
        guard.resize(nz);
    }

    pub async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }

    async fn spawn_worker(
        &self,
        slug: &str,
        handler_dir: &Path,
        caps: &Capabilities,
    ) -> Result<Worker, SpawnError> {
        let child = self.sandbox.spawn(slug, handler_dir, caps).map_err(SpawnError::Io)?;
        let paths = Sandpath { handler_dir: handler_dir.to_path_buf() };
        Worker::from_child(slug.to_string(), paths, child)
            .await
            .map_err(SpawnError::Boot)
    }

    pub async fn get_or_spawn<'a>(
        self: &'a Arc<Self>,
        slug: &str,
        handler_dir: &Path,
        caps: &Capabilities,
    ) -> Result<PoolGuard<'a>, SpawnError> {
        let mut guard = self.inner.lock().await;

        if guard.contains(slug) {
            let _ = guard.get(slug);
            return Ok(PoolGuard { pool: self.clone(), slug: slug.to_string(), guard });
        }

        if guard.len() >= guard.cap().get() {
            evict_lru_idle(&mut guard).await;
            if guard.len() >= guard.cap().get() {
                return Err(SpawnError::NoCapacity);
            }
        }

        let worker = self.spawn_worker(slug, handler_dir, caps).await?;
        let _ = guard.put(slug.to_string(), worker);
        Ok(PoolGuard { pool: self.clone(), slug: slug.to_string(), guard })
    }

    pub async fn evict(&self, slug: &str) {
        let mut guard = self.inner.lock().await;
        if let Some(mut w) = guard.pop(slug) {
            drop(guard);
            let _ = w.shutdown().await;
        }
    }
}

async fn evict_lru_idle(guard: &mut LruCache<String, Worker>) {
    let keys: Vec<String> = guard.iter().rev().map(|(k, _)| k.clone()).collect();
    for k in keys {
        let inflight = guard.peek(&k).map(|w| w.is_inflight()).unwrap_or(false);
        if !inflight {
            if let Some(mut w) = guard.pop(&k) {
                tokio::spawn(async move {
                    let _ = w.shutdown().await;
                });
                return;
            }
        }
    }
}

pub struct PoolGuard<'a> {
    pub pool: Arc<Pool>,
    pub slug: String,
    pub guard: tokio::sync::MutexGuard<'a, LruCache<String, Worker>>,
}

impl<'a> PoolGuard<'a> {
    pub fn worker_mut(&mut self) -> Option<&mut Worker> {
        self.guard.peek_mut(&self.slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge_sandbox::Capabilities;
    use std::path::Path;
    use std::process::Stdio;
    use tokio::process::Command as TokioCommand;

    struct MockSandbox;
    impl Sandbox for MockSandbox {
        fn spawn(&self, _slug: &str, _handler_dir: &Path, _caps: &Capabilities) -> std::io::Result<tokio::process::Child> {
            TokioCommand::new("/bin/sh")
                .arg("-c")
                .arg(r#"echo '{"id":"__boot__","ok":true}'; cat"#)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
        }
    }

    #[tokio::test]
    async fn pool_spawns_on_miss() {
        let pool = Arc::new(Pool::new(Box::new(MockSandbox), 4));
        let caps = Capabilities::default();
        let dir = std::env::temp_dir();
        {
            let mut g = pool.get_or_spawn("a", &dir, &caps).await.expect("spawn");
            assert!(g.worker_mut().is_some());
        }
        assert_eq!(pool.len().await, 1);
    }

    #[tokio::test]
    async fn pool_reuses_on_hit() {
        let pool = Arc::new(Pool::new(Box::new(MockSandbox), 4));
        let caps = Capabilities::default();
        let dir = std::env::temp_dir();
        let pid_a;
        {
            let mut g = pool.get_or_spawn("a", &dir, &caps).await.expect("spawn");
            pid_a = g.worker_mut().unwrap().pid;
        }
        {
            let mut g = pool.get_or_spawn("a", &dir, &caps).await.expect("hit");
            assert_eq!(g.worker_mut().unwrap().pid, pid_a, "expected same worker");
        }
        assert_eq!(pool.len().await, 1);
    }

    #[tokio::test]
    async fn pool_evicts_lru_when_at_cap() {
        let pool = Arc::new(Pool::new(Box::new(MockSandbox), 2));
        let caps = Capabilities::default();
        let dir = std::env::temp_dir();
        { let _g = pool.get_or_spawn("a", &dir, &caps).await.expect("a"); }
        { let _g = pool.get_or_spawn("b", &dir, &caps).await.expect("b"); }
        assert_eq!(pool.len().await, 2);
        { let _g = pool.get_or_spawn("a", &dir, &caps).await.expect("a-touch"); }
        { let _g = pool.get_or_spawn("c", &dir, &caps).await.expect("c"); }
        assert_eq!(pool.len().await, 2);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn pool_evict_removes_specific_slug() {
        let pool = Arc::new(Pool::new(Box::new(MockSandbox), 4));
        let caps = Capabilities::default();
        let dir = std::env::temp_dir();
        { let _g = pool.get_or_spawn("x", &dir, &caps).await.expect("x"); }
        assert_eq!(pool.len().await, 1);
        pool.evict("x").await;
        assert_eq!(pool.len().await, 0);
    }
}
