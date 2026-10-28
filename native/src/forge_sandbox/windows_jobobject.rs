// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge sandbox — Windows JobObject limits.
//
// JobObject groups the sandboxed child process and applies hard limits:
//   - 512 MB memory cap (process-level)
//   - 60s CPU time cap
//   - 1 active process (no descendants)
//   - KILL_ON_JOB_CLOSE so a panic in the parent reaps the child

#![cfg(target_os = "windows")]

use std::io;
use std::mem::{size_of, zeroed};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
};

pub const MEMORY_CAP_BYTES: usize = 512 * 1024 * 1024;
/// CPU time cap in 100-ns units: 60 seconds.
pub const CPU_TIME_CAP_100NS: i64 = 60 * 10_000_000;

pub struct ScopedJob {
    handle: HANDLE,
}

impl ScopedJob {
    pub fn as_handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for ScopedJob {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

unsafe impl Send for ScopedJob {}

/// Create a JobObject with the standard supervisor limits applied.
pub fn create_supervisor_job() -> io::Result<ScopedJob> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = ScopedJob { handle };

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    let mut basic: JOBOBJECT_BASIC_LIMIT_INFORMATION = unsafe { zeroed() };

    basic.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_TIME
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    basic.ActiveProcessLimit = 1;
    basic.PerJobUserTimeLimit = CPU_TIME_CAP_100NS;

    info.BasicLimitInformation = basic;
    info.ProcessMemoryLimit = MEMORY_CAP_BYTES;

    let ok = unsafe {
        SetInformationJobObject(
            job.as_handle(),
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(job)
}

/// Assign the given process handle to the job.
pub fn assign(job: &ScopedJob, process: HANDLE) -> io::Result<()> {
    let ok = unsafe { AssignProcessToJobObject(job.as_handle(), process) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_supervisor_job_succeeds() {
        let _job = create_supervisor_job().expect("create job");
    }

    #[test]
    fn memory_cap_is_512mb() {
        assert_eq!(MEMORY_CAP_BYTES, 512 * 1024 * 1024);
    }

    #[test]
    fn cpu_cap_is_60_seconds_in_100ns_units() {
        assert_eq!(CPU_TIME_CAP_100NS, 60 * 10_000_000);
    }
}
