// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Forge sandbox — Linux seccomp-bpf filter builder.
//
// Two-tier strategy: the allowlist covers every syscall Node.js needs for
// fs.read/fs.write under our policy plus thread/futex/timer plumbing. Any
// syscall NOT on the allowlist returns EPERM via SCMP_ACT_ERRNO so the
// handler observes a clean filesystem/network error and can surface it as a
// `cap_denied` IPC response.
//
// The filter is built and serialized to BPF instructions BEFORE fork, then
// loaded inside the pre_exec closure (async-signal-safe context — no heap
// allocation allowed there).

#![cfg(target_os = "linux")]

use seccompiler::{BpfProgram, SeccompAction, SeccompFilter, SeccompRule, TargetArch};
use std::collections::BTreeMap;

use crate::forge_sandbox::Capabilities;

/// Build a seccomp filter from the capability declaration. Returns the
/// compiled BPF program; the caller installs it via prctl + seccomp(2)
/// inside pre_exec.
pub fn build_filter(_caps: &Capabilities) -> Result<BpfProgram, seccompiler::Error> {
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

    for syscall in ALLOWED_SYSCALLS.iter().copied() {
        rules.insert(syscall, vec![]);
    }

    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Errno(libc::EPERM as u32),
        SeccompAction::Allow,
        target_arch(),
    )?;

    Ok(filter.try_into()?)
}

fn target_arch() -> TargetArch {
    #[cfg(target_arch = "x86_64")]
    {
        TargetArch::x86_64
    }
    #[cfg(target_arch = "aarch64")]
    {
        TargetArch::aarch64
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        compile_error!("forge sandbox seccomp filter requires x86_64 or aarch64")
    }
}

/// Syscall numbers Node + libuv need under our capability model.
const ALLOWED_SYSCALLS: &[i64] = &[
    // File descriptor I/O
    libc::SYS_read,
    libc::SYS_write,
    libc::SYS_openat,
    libc::SYS_close,
    libc::SYS_stat,
    libc::SYS_fstat,
    libc::SYS_lstat,
    libc::SYS_newfstatat,
    libc::SYS_poll,
    libc::SYS_lseek,
    libc::SYS_pread64,
    libc::SYS_pwrite64,
    libc::SYS_readv,
    libc::SYS_writev,
    libc::SYS_access,
    libc::SYS_getdents64,
    libc::SYS_readlink,
    libc::SYS_readlinkat,
    libc::SYS_fcntl,
    libc::SYS_dup,
    libc::SYS_dup2,
    libc::SYS_dup3,
    libc::SYS_pipe,
    libc::SYS_pipe2,
    libc::SYS_chdir,
    libc::SYS_getcwd,
    libc::SYS_umask,
    // Memory
    libc::SYS_mmap,
    libc::SYS_mprotect,
    libc::SYS_munmap,
    libc::SYS_brk,
    libc::SYS_mremap,
    libc::SYS_msync,
    libc::SYS_mincore,
    libc::SYS_madvise,
    // Threading + sync
    libc::SYS_futex,
    libc::SYS_set_robust_list,
    libc::SYS_get_robust_list,
    libc::SYS_sched_yield,
    libc::SYS_set_tid_address,
    libc::SYS_clone3,
    libc::SYS_clone, // glibc <2.34 fallback when clone3 returns ENOSYS
    libc::SYS_rseq,  // required by glibc ≥2.35 pthread_create
    libc::SYS_sigaltstack,
    // Process + signal
    libc::SYS_rt_sigaction,
    libc::SYS_rt_sigprocmask,
    libc::SYS_rt_sigreturn,
    libc::SYS_ioctl,
    libc::SYS_prctl,
    libc::SYS_arch_prctl,
    libc::SYS_execve, // REQUIRED — seccomp loads before kernel execs the child
    libc::SYS_exit,
    libc::SYS_exit_group,
    libc::SYS_wait4,
    libc::SYS_getpid,
    libc::SYS_gettid,
    // Identity / introspection
    libc::SYS_getuid,
    libc::SYS_getgid,
    libc::SYS_geteuid,
    libc::SYS_getegid,
    libc::SYS_uname,
    libc::SYS_getrusage,
    libc::SYS_prlimit64,
    libc::SYS_getrandom,
    // Time
    libc::SYS_clock_gettime,
    libc::SYS_clock_nanosleep,
    libc::SYS_nanosleep,
    // Event loop
    libc::SYS_select,
    libc::SYS_epoll_create1,
    libc::SYS_epoll_ctl,
    libc::SYS_epoll_wait,
    libc::SYS_eventfd2,
    libc::SYS_signalfd4,
    libc::SYS_timerfd_create,
    libc::SYS_timerfd_settime,
    // Sockets — network-namespace gates outbound at L3.
    libc::SYS_socket,
    libc::SYS_connect,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_accept4,
    libc::SYS_setsockopt,
    libc::SYS_getsockopt,
    libc::SYS_recvfrom,
    libc::SYS_sendto,
    libc::SYS_sendmsg,
    libc::SYS_recvmsg,
    libc::SYS_getsockname,
    libc::SYS_getpeername,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_caps() -> Capabilities {
        Capabilities::default()
    }

    #[test]
    fn build_filter_succeeds_for_empty_caps() {
        let caps = empty_caps();
        let bpf = build_filter(&caps).expect("filter builds");
        assert!(!bpf.is_empty(), "BPF program must contain instructions");
    }

    #[test]
    fn allowed_syscalls_include_read_write_openat() {
        assert!(ALLOWED_SYSCALLS.contains(&libc::SYS_read));
        assert!(ALLOWED_SYSCALLS.contains(&libc::SYS_write));
        assert!(ALLOWED_SYSCALLS.contains(&libc::SYS_openat));
        assert!(ALLOWED_SYSCALLS.contains(&libc::SYS_futex));
        assert!(ALLOWED_SYSCALLS.contains(&libc::SYS_epoll_wait));
    }

    #[test]
    fn allowed_syscalls_exclude_dangerous_ops() {
        let denied = [
            // SYS_execve is NOT in the denied list — the kernel needs it to
            // switch the process image after seccomp loads in pre_exec.
            libc::SYS_ptrace,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_init_module,
            libc::SYS_delete_module,
            libc::SYS_reboot,
            libc::SYS_swapon,
            libc::SYS_swapoff,
            libc::SYS_pivot_root,
            libc::SYS_setns,
            libc::SYS_unshare,
            libc::SYS_bpf,
            libc::SYS_userfaultfd,
            libc::SYS_kexec_load,
        ];
        for syscall in denied {
            assert!(
                !ALLOWED_SYSCALLS.contains(&syscall),
                "syscall {} must not be allowed",
                syscall
            );
        }
    }

    #[test]
    fn filter_compiles_to_bpf_program() {
        let caps = empty_caps();
        let bpf = build_filter(&caps).expect("compile");
        assert!(
            bpf.len() >= 10,
            "BPF program suspiciously short: {}",
            bpf.len()
        );
    }
}
