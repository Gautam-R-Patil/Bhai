# Windows Testing Handoff — Phase 4 Forge Sandbox + ATLAS Desktop

**Date:** 2026-05-17
**Branch:** `main` (Phase 4 merged via `e9cc8e2`, selectModel fix at `d95bd1c`)
**Author:** Dheeraj + Claude (Phase 4 implementation pair)
**Reader:** you, on a Windows machine

---

## TL;DR — what to do

1. **Check out main** on a Windows box with Node 20+, npm, Rust toolchain, Visual Studio Build Tools 2022 (with "Desktop development with C++" workload).
2. Run the build pipeline.
3. Run the unit + integration tests.
4. Try to test the **Windows sandbox path** (currently a documented stub — see "Windows backend status" below).
5. **Fix what's broken**, push to a `fix/windows-*` branch, open a PR.

---

## Status snapshot of what was shipped on macOS

Phase 4 = a Rust kernel-sandbox supervisor for LLM-synthesized persisted tools. The macOS side is fully working end-to-end (verified by running adversarial tests that try to read `/etc/passwd` — kernel returns EACCES).

| Component | macOS | Linux | Windows |
|-----------|-------|-------|---------|
| Capability data model + manifest (TS) | ✅ Working | ✅ Working | ✅ Working (TS is portable) |
| Rust supervisor core (Pool, Worker, StrikeBoard) | ✅ Working | ✅ Working | ✅ Compiles |
| Sandbox backend | ✅ `sandbox-exec` SBPL | ✅ seccomp+landlock+netns (code-only, untested) | ⚠️ **STUB** — see below |
| napi exports | ✅ Working | ✅ Compiles | ✅ Compiles |
| TS shim (`sandbox-supervisor.ts`) | ✅ Working | ✅ Should work | ✅ Should work |
| Approval gate + agent tools | ✅ Working | ✅ Should work | ✅ Should work |
| `awaiting_dynamic_tool_approval` plan-mode state | ✅ Working | ✅ Should work | ✅ Should work |
| Adversarial bypass suite (15 patterns) | ✅ All 15 pass | not run | not run |

---

## Windows backend status — KNOWN INCOMPLETE

`native/src/forge_sandbox/windows.rs` is a **deliberate stub** — calling `WindowsSandbox::spawn` always returns `io::ErrorKind::Unsupported` with this message:

> "WindowsSandbox: AppContainer-isolated spawn requires tokio Child::from_raw_handles (not yet exposed in tokio 1.x). Helpers in windows_appcontainer.rs + windows_jobobject.rs are production-ready; integration deferred until tokio ships the conversion API or a fork is vendored."

**The helpers ARE done:**
- `windows_appcontainer.rs` — `ensure_profile(slug)` creates/derives a per-tool AppContainer SID (idempotent — `ERROR_ALREADY_EXISTS` → `DeriveAppContainerSidFromAppContainerName` fallback). `sid_to_string()` for diagnostics + tests.
- `windows_jobobject.rs` — `create_supervisor_job()` builds a JobObject with 512MB memory cap, 60s CPU cap, ActiveProcessLimit=1, KILL_ON_JOB_CLOSE. `assign(job, process)` to attach.
- `windows_managed_process.rs` — `WindowsManagedProcess` wraps raw HANDLE pair from `CreateProcessAsUserW`, implements `kill` (TerminateProcess), `wait` (WaitForSingleObject + GetExitCodeProcess).

**What's blocking the real wire-up:**

Our `Sandbox` trait returns `tokio::process::Child`. macOS + Linux paths build the child via `tokio::process::Command` which already returns a tokio Child. On Windows, AppContainer requires `CreateProcessAsUserW` with a `STARTUPINFOEX` carrying `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` — that returns a raw `HANDLE`, not a `tokio::process::Child`, and tokio 1.x has no public API to convert one to the other (see open issue tokio-rs/tokio#2837).

Two paths forward:

1. **Vendor a small fork of `tokio::process::Child`** that exposes a private constructor accepting raw handles. ~200 lines, mechanically straightforward but maintenance burden.
2. **Wait for tokio to ship `Child::from_raw_handles`** (no ETA).

For now I'd recommend **option 1** since the Phase 4 design depends on the OS sandbox actually working on Windows.

---

## Environment setup on Windows

### Required tools

```powershell
# Node 20 LTS or newer
node --version  # should be >= 20.0.0

# Rust stable (msvc toolchain — NOT gnu)
rustup default stable-x86_64-pc-windows-msvc
rustc --version  # should be >= 1.75

# Visual Studio Build Tools 2022 with "Desktop development with C++" workload
# (provides MSVC linker + Windows SDK)

# Git
git --version
```

### Clone + branch

```powershell
git clone https://github.com/dheeraj-codingdesk/ATLAS.git
cd ATLAS
git checkout main
git log --oneline -5  # should see d95bd1c at top (selectModel fix)
```

### Install deps + build native

```powershell
npm install
npm run build:native
# Expect: cargo builds atlas-native + emits atlas-native.win32-x64-msvc.node
```

Build output will be `native/atlas-native.win32-x64-msvc.node`. If it's missing, the napi-rs auto-detect for the platform isn't firing — check the platform tag with `node -e "console.log(process.platform, process.arch)"`.

### Build TS

```powershell
npm run build
```

---

## Run the test suite on Windows

### Unit tests — should all pass

```powershell
npm test -- src/
```

Expected: ~2767 pass / 1 skipped / 1 pre-existing fail (perception-router).

If you see new failures around `model-router`, that's likely the `tokio_rt` napi feature not building on MSVC — let me know.

### Rust unit tests — should all pass

```powershell
cd native
cargo test --lib forge_sandbox
```

Expected: 44/44 pass (skips `#[cfg(target_os = "macos")]` modules cleanly; runs Windows-specific tests if you wrote them).

### Windows-specific Rust tests — currently `#[ignore]`'d

```powershell
cargo test --lib forge_sandbox -- --ignored
```

These are the macOS integration tests; they will SKIP on Windows because of `#![cfg(target_os = "macos")]` at the file level. **None of the Windows backend has executable integration tests yet** — that's the gap to close.

### E2E scripts on Windows — currently macOS-only

```powershell
node scripts/phase4-e2e-test.mjs
```

This will likely fail because:
- `WindowsSandbox::spawn` returns `Unsupported`.
- The script uses `/etc/passwd` as the adversarial target, which doesn't exist on Windows.

**Adapt for Windows:** swap `/etc/passwd` for `C:\Windows\System32\config\SAM` (locked even for admin), and gate the script with `if (process.platform === "win32")`.

---

## What to test (in priority order)

### P0 — get the Windows sandbox actually spawning

1. **Pick a strategy** for std → tokio Child conversion (vendor a fork vs wait for upstream).
2. **Wire `WindowsSandbox::spawn`** to use the existing helpers:
   - `ensure_profile(slug)` → AppContainer SID
   - Build `SECURITY_CAPABILITIES` + `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
   - Apply ACL grants for `caps.fs_read` / `caps.fs_write` paths via `SetNamedSecurityInfoW` adding `GENERIC_READ` / `GENERIC_WRITE` for the AppContainer SID
   - `CreateProcessAsUserW` with `EXTENDED_STARTUPINFO_PRESENT` flag + `CREATE_SUSPENDED`
   - `create_supervisor_job()` + `assign(job, processHandle)`
   - `ResumeThread(threadHandle)` to start the process
   - Wrap the raw handles in `WindowsManagedProcess`
   - Convert that into a `tokio::process::Child` (the blocking question)

3. **Verify Node can boot under AppContainer**. Quirk: Node's V8 may need specific Win32 primitives that AppContainer denies by default. macOS hit similar issues with `iokit-open` + `mach-priv-task-port` — `commit 8633018` documents what V8 needed. Watch for V8 startup aborts and add the equivalent AppContainer capability if blocked.

### P1 — adversarial bypass tests on Windows

Adapt `src/forge/__tests__/capability-bypass.test.ts` for Windows:

- Replace `/etc/passwd` reads with `C:\Windows\System32\config\SAM` or `C:\Users\<other-user>\NTUSER.DAT`
- Replace `169.254.169.254` (AWS metadata) checks with the Azure equivalent `169.254.169.254` (it's the same on Azure VMs — actually still good)
- Replace `process.binding("spawn_sync")` test — Node's child_process should be blocked by AppContainer's restricted internet/file caps anyway
- Replace `fs.symlink` test — Windows uses different symlink permissions; test `mklink /D` equivalent

All 15 patterns should defeat the sandbox the same way they do on macOS. If any succeed, AppContainer caps are too broad.

### P2 — per-host network filtering

macOS v1 grants any-host on TCP 80/443/53. Windows is similar — AppContainer's `internetClient` capability is binary (grant outbound to ANY host, or grant none). The approval-gate message in `src/forge/approval-gate.ts` already discloses this v1 limitation.

If you want per-host filtering on Windows:
- Windows Filtering Platform (WFP) — substantial Win32 work. Adds ~1000 lines of Rust.
- Userspace HTTP-CONNECT proxy in the parent process that enforces hostname allowlist before forwarding. ~300 lines of Rust + handler-shim.js change to use `HTTPS_PROXY` env.

Option B is much cheaper and gives equivalent security for HTTP/HTTPS (skips raw TCP — but raw TCP from a sandboxed handler is rare).

### P3 — Cargo.toml platform deps

`native/Cargo.toml` already has the Windows deps under `[target.'cfg(target_os = "windows")'.dependencies]`:

```toml
windows-sys = { version = "0.59", features = [
    "Win32_Foundation",
    "Win32_Security",
    "Win32_Security_Authorization",
    "Win32_Security_AppLocker",  # alias used by AppContainer in v0.59
    "Win32_Storage_FileSystem",
    "Win32_System_JobObjects",
    "Win32_System_Threading",
    "Win32_System_Pipes",
    "Win32_System_Memory",
    "Win32_System_Diagnostics_Debug",
    "Win32_System_SystemServices",
    "Win32_UI_Shell",
] }
```

If `cargo build` on Windows complains about missing feature flags (windows-sys 0.59 occasionally renames feature umbrellas), add what it asks for.

---

## Build the Windows app

After the sandbox is working:

```powershell
npm run build:all  # native + TS
cd desktop
npm run build:win:protected  # produces NSIS installer
```

The installer will be at `desktop/dist/A.T.L.A.S Setup 0.2.1.exe` (or similar — check `desktop/package.json`'s `productName`).

**Signing notes** (per the existing F6 build comments): set `CSC_LINK` to a path or base64-encoded `.pfx` cert, `WIN_CSC_KEY_PASSWORD` to its password. Without signing, Windows Defender SmartScreen will scare-warn users on first launch.

---

## Phase 4 architectural reference

### Key files (for orientation)

| File | Purpose |
|------|---------|
| `native/src/forge_sandbox/mod.rs` | `Sandbox` trait + `Capabilities` struct + per-OS `make_sandbox()` factory |
| `native/src/forge_sandbox/worker.rs` | `Worker` struct: child handle + single-flight + invoke + timeout-kill + shutdown |
| `native/src/forge_sandbox/pool.rs` | LRU `tokio::sync::Mutex<LruCache>` cap 10, never evicts inflight |
| `native/src/forge_sandbox/strikes.rs` | Three-strike auto-archive over 1h rolling window |
| `native/src/forge_sandbox/api.rs` | napi exports: `forge_invoke_tool`, `forge_spawn_warm`, `forge_evict`, `forge_strikes`, `forge_clear_strikes`, `forge_set_pool_size` |
| `native/src/forge_sandbox/macos.rs` | sandbox-exec SBPL backend (REFERENCE for what Windows needs to do) |
| `native/src/forge_sandbox/linux.rs` | seccomp + landlock + netns via pre_exec |
| `native/src/forge_sandbox/windows*.rs` | The Windows pieces — see above for status |
| `src/forge/sandbox-supervisor.ts` | TS shim wrapping the napi exports; handler-hash recheck; install/invoke/uninstall |
| `src/forge/orchestrator.ts` | `synthesizeTool` persistent branch; `approveDynamicTool` + state-gate; `revokeDynamicTool`; boot-scan |
| `src/forge/capabilities.ts` | `parseCapabilities`, `validateCapabilities` (rejects traversal, control chars, SBPL metachars, IPv6 loopback) |
| `src/forge/manifest.ts` | Atomic locked manifest read/write w/ symlink reject + slug-traversal guard |
| `src/forge/approval-gate.ts` | Per-channel approval/revocation message builder |
| `src/tools/forge-approval.ts` | `approve_dynamic_tool` + `revoke_dynamic_tool` agent tools |
| `src/agents/plan-mode.ts` | `awaiting_dynamic_tool_approval` state + allowlist + entry/exit |

### Critical security invariants (don't break these)

1. **Handler-hash recheck at invoke time.** `invokePersistedTool` (in `sandbox-supervisor.ts:120-160`) recomputes sha256 of `handler.js` on every invoke and refuses if it differs from `manifest.handlerHash`. This defeats post-approval tampering. The same recheck happens at boot-scan in `orchestrator.ts:scanAndRegisterApprovedTools`.

2. **Plan-mode state gate on approval.** `approveDynamicTool` (`orchestrator.ts:440+`) refuses unless `getPlanModeState().mode === "awaiting_dynamic_tool_approval"` AND the pending slug matches. This stops LLM self-approval.

3. **Server-side banned-word recheck.** `approveDynamicTool` mirrors the agent-side banned-word list in `forge-approval.ts:7-22`. If you add banned phrases, add to BOTH places.

4. **`/.atlas/store/dynamic/` is hard-denied** in `HARD_DENY_SUBSTRINGS` so tools can't declare self-tampering caps.

5. **Path traversal rejected.** `validateCapabilities` rejects any path containing `..` or `//`. Otherwise `/..` canonicalizes to `/` and the tool gets the whole filesystem.

6. **Capabilities flow through verbatim from envelope.** `synthesizeTool` calls `parseCapabilitiesLooseInput(result.envelope.capabilities_declared)` — DO NOT hardcode empty caps like the original Phase 3 stub did.

### Approval flow at runtime

```
User: "create a tool that reads my downloads folder"
  ↓
LLM: create_tool({persistent: true, handler_code: "...", capabilities_declared: ["fs_read:~/Downloads/"]})
  ↓
orchestrator.synthesizeTool:
  ↓
  Phase 3 verifier loop (compile + tests + critics)
  ↓
  Writes manifest.json + handler.js to ~/.atlas/store/dynamic/<slug>/
  ↓
  library.setLifecycleState(slug, "awaiting_approval")
  ↓
  plan-mode.enterAwaitingDynamicToolApproval(slug)  ← gates the agent
  ↓
  Returns { kind: "awaiting_approval", slug, capabilitiesRequested }
  ↓
Agent renders approval message via approval-gate.buildApprovalMessage(manifest, channel)
  ↓
Sends to user; agent can ONLY call approve_dynamic_tool / revoke_dynamic_tool / channel-sender
  ↓
User types "yes I approve this Downloads-reader tool"
  ↓
LLM: approve_dynamic_tool({slug, user_quote: "yes I approve this Downloads-reader tool"})
  ↓
  Server checks: plan-mode state == awaiting_dynamic_tool_approval && pending slug matches && quote ≥10 chars && not in banned list
  ↓
  manifest.approvedAt = Date.now(); writeManifest
  ↓
  forge_spawn_warm — pre-warms a sandboxed worker
  ↓
  registry.set(slug, {schema, handler}) — handler calls invokePersistedTool
  ↓
  library.setLifecycleState(slug, "active")
  ↓
  plan-mode.exitPlanMode() — back to act
  ↓
Agent can now call the tool by name; every invocation goes through the kernel sandbox.
```

---

## Quick test prompt for Windows

After you get the sandbox working, drop this into ATLAS:

```
Please create a persistent tool called `win_test_doubler`:
- description: "Doubles input.x"
- handler_code: "return { doubled: input.x * 2 };"
- parameters_schema: {"type":"object","properties":{"x":{"type":"number"}}}
- persistent: true

After it goes to awaiting_approval, show me the manifest summary. I will
type my exact approval text. Use my verbatim text as user_quote.

Then call win_test_doubler({x:21}) — expect {doubled:42}.

Then create `win_test_evil`:
- description: "Reads the SAM hive"
- handler_code: 'const fs=require("node:fs"); try { return {leaked: fs.readFileSync("C:/Windows/System32/config/SAM").length}; } catch(e) { return {denied:true, code:e.code, message:e.message}; }'
- parameters_schema: {"type":"object","properties":{}}
- persistent: true

After my approval, invoke win_test_evil({}). Expected:
  {denied: true, code: "EACCES" or "EBUSY" or similar}

If it returns {leaked: <number>}, AppContainer is broken.

Finally call revoke_dynamic_tool({slug:"win_test_evil"}).
```

---

## Where to ask questions / report issues

If you hit weird Windows-specific bugs I haven't anticipated:

1. Check `docs/superpowers/specs/2026-05-16-forge-sandbox-rust-supervisor-design.md` for the original design rationale.
2. Check `docs/superpowers/plans/2026-05-16-forge-sandbox-plan3-linux-windows.md` for the Linux+Windows plan (what I was supposed to do but couldn't on a Mac).
3. The 4-pass review fix history is in commits matching `git log --oneline --grep "review pass"` on main.
4. The 15-pattern adversarial bypass suite is in `src/forge/__tests__/capability-bypass.test.ts` — the canonical set of attacks to defeat.

If the Windows backend hits something fundamental that needs a design change (e.g. tokio fork required, or AppContainer can't run Node V8), open an issue with concrete repro and we'll figure out the rearchitecture.

Good luck.
