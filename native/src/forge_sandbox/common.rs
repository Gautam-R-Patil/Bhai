// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Shared parsing helpers for the forge sandbox.

use crate::forge_sandbox::Capabilities;
use serde::Deserialize;

/// Wire shape from the TS shim — keep it permissive and validate after parse.
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct CapsWire {
    fs_read: Vec<String>,
    fs_write: Vec<String>,
    net: Vec<String>,
    exec: Vec<String>,
}

/// Parse a JSON string into a `Capabilities`. Missing keys default to empty
/// arrays — the TS shim is the source of truth for canonicalization (path
/// expansion, host validation); Rust trusts only the parsed shape.
pub fn parse_capabilities(json: &str) -> Result<Capabilities, String> {
    let wire: CapsWire =
        serde_json::from_str(json).map_err(|e| format!("capabilities parse error: {e}"))?;
    Ok(Capabilities {
        fs_read: wire.fs_read,
        fs_write: wire.fs_write,
        net: wire.net,
        exec: wire.exec,
    })
}

/// Returns the embedded handler-shim.js source as a static str. The shim is
/// compiled into the binary so the supervisor doesn't depend on a sibling JS
/// file on disk — every spawn writes a fresh copy to the handler_dir.
pub fn handler_shim_source() -> &'static str {
    include_str!("handler-shim.js")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_capabilities() {
        let json = r#"{
            "fs_read": ["/Users/x/Downloads/"],
            "fs_write": ["/tmp/"],
            "net": ["api.openai.com"],
            "exec": ["/usr/bin/ffmpeg"]
        }"#;
        let caps = parse_capabilities(json).expect("must parse");
        assert_eq!(caps.fs_read, vec!["/Users/x/Downloads/"]);
        assert_eq!(caps.fs_write, vec!["/tmp/"]);
        assert_eq!(caps.net, vec!["api.openai.com"]);
        assert_eq!(caps.exec, vec!["/usr/bin/ffmpeg"]);
    }

    #[test]
    fn defaults_missing_keys_to_empty() {
        let caps = parse_capabilities("{}").expect("empty object must parse");
        assert!(caps.fs_read.is_empty());
        assert!(caps.fs_write.is_empty());
        assert!(caps.net.is_empty());
        assert!(caps.exec.is_empty());
    }

    #[test]
    fn rejects_invalid_json() {
        let err = parse_capabilities("{ not json").expect_err("must fail");
        assert!(err.contains("capabilities parse error"), "got: {err}");
    }

    #[test]
    fn rejects_wrong_type_for_field() {
        let err = parse_capabilities(r#"{"fs_read":"oops"}"#).expect_err("must fail");
        assert!(err.contains("parse error"), "got: {err}");
    }

    #[test]
    fn handler_shim_source_is_nonempty() {
        let src = handler_shim_source();
        assert!(
            src.len() > 50,
            "shim should be ~30 lines, got {} bytes",
            src.len()
        );
    }
}
