// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// napi-exposed entry points for the Forge sandbox supervisor.
//
// All async functions return `Promise<T>` to JS. Errors come back as
// rejected promises with `napi::Error` (kind = GenericFailure by default).
// The TS shim translates these into the `SandboxResult` shape from the spec.

use crate::forge_sandbox::common::parse_capabilities;
use crate::forge_sandbox::pool::{Pool, SpawnError};
use crate::forge_sandbox::strikes::StrikeBoard;
use crate::forge_sandbox::{make_sandbox, Capabilities};
use napi_derive::napi;
use once_cell::sync::OnceCell;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

static POOL: OnceCell<Arc<Pool>> = OnceCell::new();
static STRIKES: OnceCell<StrikeBoard> = OnceCell::new();
static POOL_CAP: parking_lot::Mutex<usize> = parking_lot::Mutex::new(10);

fn pool() -> &'static Arc<Pool> {
    POOL.get_or_init(|| {
        let cap = *POOL_CAP.lock();
        Arc::new(Pool::new(make_sandbox(), cap))
    })
}

fn strikes() -> &'static StrikeBoard {
    STRIKES.get_or_init(StrikeBoard::new)
}

fn strike_window() -> Duration {
    let ms = std::env::var("BHAI_FORGE_STRIKE_WINDOW_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(3_600_000);
    Duration::from_millis(ms)
}

fn call_timeout() -> Duration {
    let ms = std::env::var("BHAI_FORGE_CALL_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(60_000);
    Duration::from_millis(ms)
}

fn ok_result(value: serde_json::Value) -> String {
    serde_json::json!({ "ok": true, "result": value }).to_string()
}

fn err_result(kind: &str, message: impl AsRef<str>, extra: Option<serde_json::Value>) -> String {
    let mut err = serde_json::json!({ "kind": kind, "message": message.as_ref() });
    if let Some(v) = extra {
        if let Some(obj) = err.as_object_mut() {
            if let Some(extra_obj) = v.as_object() {
                for (k, v) in extra_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }
    serde_json::json!({ "ok": false, "error": err }).to_string()
}

#[napi]
pub async fn forge_invoke_tool(
    slug: String,
    handler_dir: String,
    capabilities_json: String,
    input_json: String,
) -> napi::Result<String> {
    if strikes().is_archived(&slug, strike_window()) {
        let count = strikes().count(&slug, strike_window());
        return Ok(err_result(
            "archived",
            "slug archived after repeated strikes",
            Some(serde_json::json!({
                "strikes": count, "window_ms": strike_window().as_millis() as u64,
            })),
        ));
    }

    let caps: Capabilities = match parse_capabilities(&capabilities_json) {
        Ok(c) => c,
        Err(e) => {
            return Ok(err_result(
                "spawn_failed",
                format!("capabilities parse: {e}"),
                None,
            ))
        }
    };

    let input: serde_json::Value = match serde_json::from_str(&input_json) {
        Ok(v) => v,
        Err(e) => {
            return Ok(err_result(
                "ipc_corruption",
                format!("input parse: {e}"),
                None,
            ))
        }
    };

    let handler_dir = PathBuf::from(handler_dir);
    let pool = pool();
    let timeout = call_timeout();

    let mut guard = match pool.get_or_spawn(&slug, &handler_dir, &caps).await {
        Ok(g) => g,
        Err(SpawnError::NoCapacity) => {
            return Ok(err_result("spawn_failed", "pool at capacity", None));
        }
        Err(SpawnError::Io(e)) => {
            return Ok(err_result("spawn_failed", format!("io: {e}"), None));
        }
        Err(SpawnError::Boot(e)) => {
            let _ = strikes().record(&slug, strike_window());
            let _ = strikes().record(&slug, strike_window());
            let _ = strikes().record(&slug, strike_window());
            return Ok(err_result(
                "spawn_failed",
                format!("boot: {e}"),
                Some(serde_json::json!({ "archived_immediately": true })),
            ));
        }
    };

    let worker = match guard.worker_mut() {
        Some(w) => w,
        None => return Ok(err_result("spawn_failed", "pool guard lost worker", None)),
    };

    if worker.try_acquire_inflight().is_err() {
        return Ok(err_result(
            "spawn_failed",
            "worker busy (single-flight violation)",
            None,
        ));
    }

    let result = worker.invoke(input, timeout).await;
    worker.release_inflight();

    use crate::forge_sandbox::worker::InvokeError;
    // Track whether the worker is dead/unusable after this call so we can
    // evict it from the pool (timeout kills the child, pipe/ipc imply
    // corrupted state). Recovers cleanly on the next call instead of
    // burning 3 strikes against a zombie.
    let evict_after = matches!(
        &result,
        Err(InvokeError::Timeout { .. }) | Err(InvokeError::Pipe(_)) | Err(InvokeError::Ipc(_))
    );

    let response = match result {
        Ok(resp) => {
            let ok = resp.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            if ok {
                let result_val = resp
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                ok_result(result_val)
            } else {
                let error = resp
                    .get("error")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let kind = error
                    .get("kind")
                    .and_then(|k| k.as_str())
                    .unwrap_or("handler_error")
                    .to_string();
                let message = error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                let code = error
                    .get("code")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                if kind == "cap_denied" || matches!(code.as_str(), "EACCES" | "EPERM") {
                    let _ = strikes().record(&slug, strike_window());
                }
                err_result(&kind, message, Some(error))
            }
        }
        Err(InvokeError::Timeout { budget_ms }) => {
            let _ = strikes().record(&slug, strike_window());
            err_result(
                "timeout",
                "wall-clock timeout",
                Some(serde_json::json!({ "budget_ms": budget_ms })),
            )
        }
        Err(InvokeError::Ipc(m)) => {
            let _ = strikes().record(&slug, strike_window());
            err_result("ipc_corruption", m, None)
        }
        Err(InvokeError::Pipe(e)) => {
            let _ = strikes().record(&slug, strike_window());
            err_result("spawn_failed", format!("pipe: {e}"), None)
        }
        Err(InvokeError::Busy) => err_result("spawn_failed", "worker busy", None),
        Err(InvokeError::Other(m)) => err_result("spawn_failed", m, None),
    };

    drop(guard);
    if evict_after {
        pool.evict(&slug).await;
    }
    Ok(response)
}

#[napi]
pub async fn forge_spawn_warm(
    slug: String,
    handler_dir: String,
    capabilities_json: String,
) -> napi::Result<()> {
    let caps = parse_capabilities(&capabilities_json)
        .map_err(|e| napi::Error::from_reason(format!("capabilities: {e}")))?;
    let handler_dir = PathBuf::from(handler_dir);
    let pool = pool();
    pool.get_or_spawn(&slug, &handler_dir, &caps)
        .await
        .map_err(|e| napi::Error::from_reason(format!("warm spawn: {e}")))?;
    Ok(())
}

#[napi]
pub async fn forge_evict(slug: String) -> napi::Result<()> {
    pool().evict(&slug).await;
    Ok(())
}

#[napi]
pub fn forge_strikes(slug: String) -> napi::Result<u32> {
    Ok(strikes().count(&slug, strike_window()) as u32)
}

#[napi]
pub fn forge_clear_strikes(slug: String) -> napi::Result<()> {
    strikes().clear(&slug);
    Ok(())
}

#[napi]
pub fn forge_set_pool_size(size: u32) -> napi::Result<()> {
    let new_cap = (size as usize).max(1);
    *POOL_CAP.lock() = new_cap;
    if let Some(p) = POOL.get() {
        let p = p.clone();
        tokio::task::spawn(async move { p.set_cap(new_cap).await });
    }
    Ok(())
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    #[ignore]
    async fn api_invoke_tool_roundtrips() {
        let dir = TempDir::new().expect("tempdir");
        let handler_dir = dir.path();
        std::fs::write(
            handler_dir.join("handler.js"),
            b"module.exports = async (input) => ({ tripled: input.x * 3 });\n",
        )
        .expect("write handler");

        let caps_json = r#"{"fs_read":[],"fs_write":[],"net":[],"exec":[]}"#;
        let input_json = r#"{"x":7}"#;

        let raw = forge_invoke_tool(
            "api-itest".into(),
            handler_dir.to_string_lossy().into(),
            caps_json.into(),
            input_json.into(),
        )
        .await
        .expect("napi call");

        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("response is JSON");
        assert!(
            parsed.get("ok").and_then(|o| o.as_bool()).unwrap_or(false),
            "expected ok:true, got {parsed}"
        );
        let tripled = parsed
            .pointer("/result/tripled")
            .and_then(|v| v.as_i64())
            .expect("/result/tripled");
        assert_eq!(tripled, 21);
    }

    #[test]
    fn forge_strikes_returns_zero_for_unknown_slug() {
        let r = forge_strikes("never_seen_slug".into()).expect("ok");
        assert_eq!(r, 0);
    }

    #[test]
    fn forge_set_pool_size_accepts_value() {
        forge_set_pool_size(20).expect("ok");
    }
}
