// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge sandbox — Windows ManagedProcess wrapping raw Win32 handles.
//
// Used by the future Windows backend integration (windows.rs) once tokio
// exposes Child::from_raw_handles. Currently unused but kept building so
// the helpers stay valid for the eventual wire-up.

#![cfg(target_os = "windows")]

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, TerminateProcess, WaitForSingleObject, INFINITE,
};

pub struct WindowsManagedProcess {
    process: HANDLE,
    thread: HANDLE,
    pid: u32,
}

impl WindowsManagedProcess {
    pub fn new(process: HANDLE, thread: HANDLE, pid: u32) -> Self {
        Self {
            process,
            thread,
            pid,
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn kill(&mut self) -> io::Result<()> {
        let ok = unsafe { TerminateProcess(self.process, 1) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn wait(&mut self) -> io::Result<i32> {
        let r = unsafe { WaitForSingleObject(self.process, INFINITE) };
        if r != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut code: u32 = 0;
        let ok = unsafe { GetExitCodeProcess(self.process, &mut code) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(code as i32)
    }
}

impl Drop for WindowsManagedProcess {
    fn drop(&mut self) {
        unsafe {
            if !self.process.is_null() {
                let _ = CloseHandle(self.process);
            }
            if !self.thread.is_null() {
                let _ = CloseHandle(self.thread);
            }
        }
    }
}

unsafe impl Send for WindowsManagedProcess {}
