// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge sandbox — Windows AppContainer profile + ACL helpers.
//
// Per-slug AppContainer profile derived from the slug. The profile owns a SID
// the supervisor uses to ACL allow-listed paths via SetNamedSecurityInfoW.

#![cfg(target_os = "windows")]

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use windows_sys::core::PWSTR;
use windows_sys::Win32::Foundation::{LocalFree, ERROR_ALREADY_EXISTS, HLOCAL, S_OK};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::PSID;

/// `HRESULT_FROM_WIN32` is a C preprocessor macro that windows-sys does not
/// expose. For a positive Win32 error code it maps to the FACILITY_WIN32 HRESULT.
#[inline]
fn hresult_from_win32(code: u32) -> i32 {
    if code as i32 <= 0 {
        code as i32
    } else {
        ((code & 0x0000_FFFF) | (7 << 16) | 0x8000_0000) as i32
    }
}

/// Owned AppContainer SID. Drop releases the LocalAlloc'd buffer.
pub struct AppContainerSid {
    sid: PSID,
}

impl AppContainerSid {
    pub fn as_ptr(&self) -> PSID {
        self.sid
    }
}

impl Drop for AppContainerSid {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            unsafe {
                LocalFree(self.sid as HLOCAL);
            }
        }
    }
}

unsafe impl Send for AppContainerSid {}

fn to_wide(s: &str) -> Vec<u16> {
    OsString::from(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Idempotently get or create the AppContainer profile for `slug`. Returns
/// an owned SID buffer the caller must drop.
pub fn ensure_profile(slug: &str) -> io::Result<AppContainerSid> {
    let profile_name = format!("atlas-forge-{slug}");
    let display = format!("Bhai Forge sandboxed tool: {slug}");
    let description = format!("Per-slug isolated AppContainer for Bhai Forge tool '{slug}'");
    let profile_w = to_wide(&profile_name);
    let display_w = to_wide(&display);
    let desc_w = to_wide(&description);

    let mut sid: PSID = ptr::null_mut();
    let hr = unsafe {
        CreateAppContainerProfile(
            profile_w.as_ptr(),
            display_w.as_ptr(),
            desc_w.as_ptr(),
            ptr::null(),
            0,
            &mut sid,
        )
    };

    if hr == S_OK {
        return Ok(AppContainerSid { sid });
    }

    let already_exists = hr == hresult_from_win32(ERROR_ALREADY_EXISTS as u32);
    if !already_exists {
        return Err(io::Error::from_raw_os_error(hr));
    }

    // Profile already exists — derive its SID.
    let hr2 = unsafe { DeriveAppContainerSidFromAppContainerName(profile_w.as_ptr(), &mut sid) };
    if hr2 != S_OK {
        return Err(io::Error::from_raw_os_error(hr2));
    }
    Ok(AppContainerSid { sid })
}

/// Convert SID to a string form (for diagnostics + tests).
pub fn sid_to_string(sid: &AppContainerSid) -> io::Result<String> {
    let mut buf: PWSTR = ptr::null_mut();
    let ok = unsafe { ConvertSidToStringSidW(sid.as_ptr(), &mut buf) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut len = 0usize;
    unsafe {
        while *buf.add(len) != 0 {
            len += 1;
        }
    }
    let slice = unsafe { std::slice::from_raw_parts(buf, len) };
    let s = String::from_utf16_lossy(slice);
    unsafe {
        LocalFree(buf as HLOCAL);
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_profile_returns_a_sid() {
        let sid = ensure_profile("test_slug_1").expect("ensure profile");
        let s = sid_to_string(&sid).expect("sid to string");
        assert!(s.starts_with("S-1-15-"), "expected AppContainer SID prefix, got {s}");
    }

    #[test]
    fn ensure_profile_is_idempotent() {
        let sid1 = ensure_profile("test_slug_idempotent").expect("first");
        let s1 = sid_to_string(&sid1).expect("s1");
        drop(sid1);
        let sid2 = ensure_profile("test_slug_idempotent").expect("second");
        let s2 = sid_to_string(&sid2).expect("s2");
        assert_eq!(s1, s2, "second ensure should return same SID");
    }
}
