// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge sandbox — Linux Landlock LSM ruleset builder.
//
// Landlock is best-effort: kernels <5.13 don't have it at all, and even on
// newer kernels the ABI version (1-4 as of 5.19) controls which access
// rights are available. `Compatibility::BestEffort` is the default — it
// silently downgrades richer rights to weaker ones. For the strict
// supervisor mode (`ATLAS_FORGE_STRICT=true`) we promote BestEffort to
// HardRequirement and propagate failures up so install refuses.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};

use landlock::{
    Access, AccessFs, Compatibility, PathBeneath, PathFd, Ruleset, RulesetAttr,
    RulesetCreated, RulesetCreatedAttr, RulesetError, RulesetStatus, ABI,
};

use crate::forge_sandbox::Capabilities;

#[derive(Debug, thiserror::Error)]
pub enum LandlockBuildError {
    #[error("landlock not supported on this kernel (need >= 5.13)")]
    NotSupported,
    #[error("strict mode: landlock fell back to best-effort, refusing")]
    StrictFallback,
    #[error("landlock ruleset error: {0}")]
    Ruleset(#[from] RulesetError),
    #[error("io error reading path: {0}")]
    Io(#[from] std::io::Error),
}

/// Build a Landlock ruleset enforcing fs_read/fs_write capability paths.
/// Returns a `RulesetCreated` ready to call `.restrict_self()` from inside
/// pre_exec.
pub fn build_ruleset(
    caps: &Capabilities,
    strict: bool,
) -> Result<RulesetCreated, LandlockBuildError> {
    let _abi = ABI::V4;
    let compat = if strict {
        Compatibility::HardRequirement
    } else {
        Compatibility::BestEffort
    };

    let read_rights = AccessFs::ReadFile | AccessFs::ReadDir;
    let write_rights = AccessFs::WriteFile
        | AccessFs::RemoveFile
        | AccessFs::RemoveDir
        | AccessFs::Truncate
        | AccessFs::MakeReg
        | AccessFs::MakeDir
        | AccessFs::MakeSym
        | AccessFs::MakeFifo
        | AccessFs::MakeSock
        | AccessFs::MakeBlock
        | AccessFs::MakeChar;

    let handled = read_rights | write_rights;

    let ruleset = Ruleset::default()
        .set_compatibility(compat)
        .handle_access(handled)?
        .create()?;

    match ruleset.as_ref().get_status() {
        RulesetStatus::NotEnforced => {
            return Err(LandlockBuildError::NotSupported);
        }
        RulesetStatus::PartiallyEnforced if strict => {
            return Err(LandlockBuildError::StrictFallback);
        }
        _ => {}
    }

    let mut ruleset = ruleset;
    for path in &caps.fs_read {
        let canonical = canonicalize_or_skip(Path::new(path))?;
        let fd = PathFd::new(&canonical)?;
        ruleset = ruleset.add_rule(PathBeneath::new(fd, read_rights))?;
    }
    for path in &caps.fs_write {
        let canonical = canonicalize_or_skip(Path::new(path))?;
        let fd = PathFd::new(&canonical)?;
        ruleset = ruleset.add_rule(PathBeneath::new(fd, write_rights))?;
    }

    Ok(ruleset)
}

fn canonicalize_or_skip(path: &Path) -> Result<PathBuf, std::io::Error> {
    std::fs::canonicalize(path)
}

/// Probe whether Landlock is available on the running kernel.
pub fn landlock_available() -> bool {
    Ruleset::default()
        .set_compatibility(Compatibility::HardRequirement)
        .handle_access(AccessFs::ReadFile)
        .and_then(|rs| rs.create())
        .map(|rs| !matches!(rs.as_ref().get_status(), RulesetStatus::NotEnforced))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps_with(fs_read: Vec<&str>, fs_write: Vec<&str>) -> Capabilities {
        Capabilities {
            fs_read: fs_read.into_iter().map(String::from).collect(),
            fs_write: fs_write.into_iter().map(String::from).collect(),
            ..Capabilities::default()
        }
    }

    #[test]
    fn build_ruleset_with_no_paths_creates_empty_ruleset() {
        if !landlock_available() {
            eprintln!("[skip] kernel lacks Landlock");
            return;
        }
        let caps = caps_with(vec![], vec![]);
        let _rs = build_ruleset(&caps, false).expect("empty ruleset builds");
    }

    #[test]
    fn build_ruleset_with_tmp_read_path() {
        if !landlock_available() {
            eprintln!("[skip] kernel lacks Landlock");
            return;
        }
        let caps = caps_with(vec!["/tmp"], vec![]);
        let _rs = build_ruleset(&caps, false).expect("tmp ruleset builds");
    }

    #[test]
    fn build_ruleset_nonexistent_path_errors() {
        if !landlock_available() {
            eprintln!("[skip] kernel lacks Landlock");
            return;
        }
        let caps = caps_with(vec!["/this/path/does/not/exist/sentinel"], vec![]);
        let err = build_ruleset(&caps, false).expect_err("must fail on missing path");
        assert!(matches!(err, LandlockBuildError::Io(_)));
    }

    #[test]
    fn strict_mode_on_unsupported_kernel_errors_clean() {
        if landlock_available() {
            eprintln!("[skip] kernel supports Landlock — strict-fallback path untestable here");
            return;
        }
        let caps = caps_with(vec![], vec![]);
        let err = build_ruleset(&caps, true).expect_err("strict + unsupported kernel must fail");
        assert!(matches!(err, LandlockBuildError::NotSupported | LandlockBuildError::StrictFallback));
    }
}
