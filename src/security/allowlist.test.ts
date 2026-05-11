// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    isProtectedPath,
    shellArgsTargetProtectedPath,
    isSystemDestructive,
    getCommandPermission,
    isCommandAllowed,
    isShellBypass,
    isCriticalSystemPath,
    isPathAllowed,
    getPathBlockedReason,
    isDomainAllowed,
    registerProtectedPath,
} from "./allowlist.js";

// PROTECTED_PATHS is populated at runtime by the host (no longer baked
// into the binary). Tests register the repo root once so the protected-
// path assertions still hold regardless of where the suite runs from.
const REPO = "/Users/user/Desktop/ATLAS";
beforeAll(() => {
    registerProtectedPath(REPO);
});

describe("allowlist — codebase self-protection", () => {
    describe("isProtectedPath", () => {
        it("returns true for the exact protected root", () => {
            expect(isProtectedPath(REPO)).toBe(true);
        });

        it("returns true for a child directory", () => {
            expect(isProtectedPath(`${REPO}/src`)).toBe(true);
        });

        it("returns true for a deep nested file", () => {
            expect(isProtectedPath(`${REPO}/src/agent.ts`)).toBe(true);
        });

        it("returns false for a sibling with a shared PREFIX (no separator)", () => {
            // The +sep guard prevents "/path/ATLAS-clone" from matching "/path/ATLAS".
            expect(isProtectedPath(`${REPO}-sibling`)).toBe(false);
            expect(isProtectedPath(`${REPO}x`)).toBe(false);
        });

        it("returns false for an unrelated absolute path", () => {
            expect(isProtectedPath("/etc/hosts")).toBe(false);
            expect(isProtectedPath("/tmp/foo")).toBe(false);
            expect(isProtectedPath("/Users/other/project")).toBe(false);
        });

        it("resolves relative paths to absolute before matching", () => {
            // A relative path resolves against process.cwd(). Since tests run
            // from the repo root, '.' resolves INTO the protected tree — the
            // function must therefore return true. This is the critical
            // guarantee: callers can't sneak a relative path past the check.
            const originalCwd = process.cwd();
            try {
                process.chdir(REPO);
                expect(isProtectedPath(".")).toBe(true);
                expect(isProtectedPath("./src/agent.ts")).toBe(true);
            } finally {
                process.chdir(originalCwd);
            }
        });

        it("handles trailing slashes idempotently", () => {
            expect(isProtectedPath(`${REPO}/`)).toBe(true);
            expect(isProtectedPath(`${REPO}/src/`)).toBe(true);
        });

        it("follows symlinks that point INTO the protected tree (TOCTOU fix)", () => {
            // Skip on Windows — symlink semantics differ and require admin.
            if (process.platform === "win32") return;

            // Create a symlink in an unprotected temp dir that points at
            // a real file inside the protected repo. Pre-fix, the bot
            // could have written "through" this symlink without the gate
            // firing. Post-fix, realResolve dereferences the link and
            // the protected-path check correctly rejects.
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-allowlist-"));
            const linkPath = path.join(tmpDir, "decoy");
            try {
                fs.symlinkSync(`${REPO}/src/agent.ts`, linkPath);
                expect(isProtectedPath(linkPath)).toBe(true);
            } finally {
                // Best-effort cleanup; never let teardown failures mask
                // the actual test result.
                try {
                    fs.unlinkSync(linkPath);
                } catch {}
                try {
                    fs.rmdirSync(tmpDir);
                } catch {}
            }
        });

        it("follows symlinks to protected directories too", () => {
            if (process.platform === "win32") return;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-allowlist-"));
            const linkPath = path.join(tmpDir, "dir-decoy");
            try {
                fs.symlinkSync(`${REPO}/src`, linkPath);
                // A file UNDER the symlinked dir should also be caught.
                expect(isProtectedPath(path.join(linkPath, "agent.ts"))).toBe(true);
                // Even one that doesn't exist yet — the realpath walk-up
                // must resolve the parent symlink.
                expect(isProtectedPath(path.join(linkPath, "new-file.ts"))).toBe(true);
            } finally {
                try {
                    fs.unlinkSync(linkPath);
                } catch {}
                try {
                    fs.rmdirSync(tmpDir);
                } catch {}
            }
        });

        it("does NOT flag symlinks that point OUTSIDE the protected tree", () => {
            if (process.platform === "win32") return;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-allowlist-"));
            const linkPath = path.join(tmpDir, "outside");
            const targetFile = path.join(tmpDir, "target.txt");
            try {
                fs.writeFileSync(targetFile, "hello");
                fs.symlinkSync(targetFile, linkPath);
                // Sanity: symlink target is in /tmp, not protected.
                expect(isProtectedPath(linkPath)).toBe(false);
            } finally {
                try {
                    fs.unlinkSync(linkPath);
                } catch {}
                try {
                    fs.unlinkSync(targetFile);
                } catch {}
                try {
                    fs.rmdirSync(tmpDir);
                } catch {}
            }
        });
    });

    // shellArgsTargetProtectedPath resolves relative args against
    // process.cwd(). If the test runner happens to be inside the
    // protected tree (it does — tests run from the repo root), a bare
    // "ls" or "cp" arg resolves INTO the protected path, and every
    // arg-without-flag is "protected." Pin CWD to /tmp so the tests
    // exercise the intended semantics.
    describe("shellArgsTargetProtectedPath", () => {
        let originalCwd: string;

        beforeEach(() => {
            originalCwd = process.cwd();
            process.chdir("/tmp");
        });

        afterEach(() => {
            process.chdir(originalCwd);
        });

        it("returns the resolved path when any arg is inside the protected tree", () => {
            const hit = shellArgsTargetProtectedPath(["ls", "-l", `${REPO}/src`]);
            expect(hit).toEqual(`${REPO}/src`);
        });

        it("returns null when no arg is protected", () => {
            expect(shellArgsTargetProtectedPath(["ls", "-l", "/tmp"])).toBeNull();
            expect(shellArgsTargetProtectedPath([])).toBeNull();
        });

        it("skips flag-style args (starting with -)", () => {
            // "-rf" mustn't be resolved as if it were a path. The important
            // property: flag-shaped args don't trigger false positives even
            // if they happen to share characters with a protected path.
            expect(shellArgsTargetProtectedPath(["rm", "-rf", "/tmp"])).toBeNull();
            expect(shellArgsTargetProtectedPath(["--flag=value"])).toBeNull();
        });

        it("catches protected path buried among other args", () => {
            const hit = shellArgsTargetProtectedPath(["cp", "a.txt", `${REPO}/b.txt`, "-v"]);
            expect(hit).toEqual(`${REPO}/b.txt`);
        });

        it("returns the FIRST protected arg when multiple match", () => {
            const first = `${REPO}/a`;
            const second = `${REPO}/b`;
            expect(shellArgsTargetProtectedPath(["cp", first, second])).toEqual(first);
        });

        it("treats relative args as resolved against CWD (behavioral contract)", () => {
            // When the process CWD is INSIDE the protected tree, any
            // relative arg (like "file.txt") resolves into it. This
            // tests the CWD-dependent behavior explicitly — callers
            // should understand that `shell_exec` with relative args
            // and a protected-tree CWD will trip the guard.
            const savedCwd = process.cwd();
            process.chdir(REPO);
            try {
                const hit = shellArgsTargetProtectedPath(["file.txt"]);
                expect(hit).toEqual(`${REPO}/file.txt`);
            } finally {
                process.chdir(savedCwd);
            }
        });
    });
});

describe("allowlist — system-destructive command detection", () => {
    describe("classic rm patterns", () => {
        it("blocks rm -rf /", () => {
            expect(isSystemDestructive("rm -rf /")).toBe(true);
            expect(isSystemDestructive("rm -rf / ")).toBe(true);
        });

        it("blocks rm -rf /*", () => {
            expect(isSystemDestructive("rm -rf /*")).toBe(true);
        });

        it("blocks rm -f / (just -f)", () => {
            expect(isSystemDestructive("rm -f /")).toBe(true);
        });

        it("blocks rm --no-preserve-root /", () => {
            expect(isSystemDestructive("rm -rf --no-preserve-root /tmp")).toBe(true);
        });

        it("blocks rm on core system directories", () => {
            expect(isSystemDestructive("rm -rf /boot")).toBe(true);
            expect(isSystemDestructive("rm -rf /System/Library")).toBe(true);
            expect(isSystemDestructive("rm -rf /Windows")).toBe(true);
            expect(isSystemDestructive("rm -rf /usr/bin")).toBe(true);
            expect(isSystemDestructive("rm -rf /sbin")).toBe(true);
            expect(isSystemDestructive("rm -rf /lib")).toBe(true);
            expect(isSystemDestructive("rm -rf /etc")).toBe(true);
        });

        it("blocks rm -rf /var exactly (bare /var, entire)", () => {
            expect(isSystemDestructive("rm -rf /var")).toBe(true);
            expect(isSystemDestructive("rm -rf /var ")).toBe(true);
        });

        it("does NOT block rm -rf on subpaths under /var (those are case-by-case)", () => {
            expect(isSystemDestructive("rm -rf /var/log/app.log")).toBe(false);
            expect(isSystemDestructive("rm -rf /var/tmp/junk")).toBe(false);
        });

        it("does NOT block rm on user / project paths", () => {
            expect(isSystemDestructive("rm -rf ./node_modules")).toBe(false);
            expect(isSystemDestructive("rm -rf /tmp/scratch")).toBe(false);
            expect(isSystemDestructive("rm /Users/x/file.txt")).toBe(false);
            expect(isSystemDestructive("rm file.txt")).toBe(false);
        });
    });

    describe("disk format / dd patterns", () => {
        it("blocks diskutil on disk0 (macOS system disk)", () => {
            expect(isSystemDestructive("diskutil eraseDisk JHFS+ MyDisk disk0")).toBe(true);
            expect(isSystemDestructive("diskutil partitionDisk disk0 1 JHFS+ MyDisk 100%")).toBe(
                true,
            );
            expect(isSystemDestructive("diskutil apfs deleteContainer disk0")).toBe(true);
        });

        it("does NOT block diskutil on non-system disks", () => {
            expect(isSystemDestructive("diskutil eraseDisk JHFS+ MyDisk disk2")).toBe(false);
            expect(isSystemDestructive("diskutil list")).toBe(false);
        });

        it("blocks mkfs on the system disk (Linux)", () => {
            expect(isSystemDestructive("mkfs.ext4 /dev/sda")).toBe(true);
            expect(isSystemDestructive("mkfs.xfs /dev/nvme0n1")).toBe(true);
            expect(isSystemDestructive("mkfs /dev/vda")).toBe(true);
        });

        it("does NOT block mkfs on external/secondary disks", () => {
            expect(isSystemDestructive("mkfs.ext4 /dev/sdb")).toBe(false);
            expect(isSystemDestructive("mkfs.ext4 /dev/sdz")).toBe(false);
        });

        it("blocks wipefs on the system disk", () => {
            expect(isSystemDestructive("wipefs -a /dev/sda")).toBe(true);
            expect(isSystemDestructive("wipefs /dev/nvme0n1")).toBe(true);
        });

        it("blocks dd writing to the system disk", () => {
            expect(isSystemDestructive("dd if=/dev/zero of=/dev/disk0 bs=1M")).toBe(true);
            expect(isSystemDestructive("dd if=/dev/urandom of=/dev/sda")).toBe(true);
            expect(isSystemDestructive("dd if=/path of=/dev/nvme0n1")).toBe(true);
        });

        it("does NOT block dd to a file", () => {
            expect(isSystemDestructive("dd if=/dev/zero of=./backup.img bs=1M")).toBe(false);
        });
    });

    describe("Windows patterns", () => {
        it("blocks format C: (case-insensitive)", () => {
            expect(isSystemDestructive("format c:")).toBe(true);
            expect(isSystemDestructive("format C:")).toBe(true);
            expect(isSystemDestructive("FORMAT C:")).toBe(true);
        });

        it("blocks diskpart clean commands", () => {
            expect(isSystemDestructive("diskpart /s script.txt clean")).toBe(true);
        });
    });

    describe("fork bomb", () => {
        it("blocks the classic bash fork bomb", () => {
            expect(isSystemDestructive(":(){ :|:& };:")).toBe(true);
        });

        it("blocks $0|$0& pattern", () => {
            expect(isSystemDestructive("$0|$0&")).toBe(true);
        });
    });

    describe("kernel / raw-device writes", () => {
        it("blocks echo > /dev/sda", () => {
            expect(isSystemDestructive("echo hello > /dev/sda")).toBe(true);
            expect(isSystemDestructive("echo x > /dev/mem")).toBe(true);
            expect(isSystemDestructive("echo x > /dev/kmem")).toBe(true);
        });

        it("blocks cat > /dev/sda", () => {
            expect(isSystemDestructive("cat data > /dev/nvme0n1")).toBe(true);
        });

        it("does NOT block echo to /dev/null", () => {
            expect(isSystemDestructive("echo hello > /dev/null")).toBe(false);
            expect(isSystemDestructive("cat data > /dev/null")).toBe(false);
        });
    });

    describe("getCommandPermission", () => {
        it('returns "block" only for destructive', () => {
            expect(getCommandPermission("rm -rf /")).toEqual("block");
            expect(getCommandPermission(":(){ :|:& };:")).toEqual("block");
        });

        it('returns "allow" for everything else', () => {
            expect(getCommandPermission("ls -la")).toEqual("allow");
            expect(getCommandPermission("rm file.txt")).toEqual("allow");
            expect(getCommandPermission("npm install")).toEqual("allow");
        });
    });

    describe("isCommandAllowed (legacy)", () => {
        it("mirrors !isSystemDestructive", () => {
            expect(isCommandAllowed("ls")).toBe(true);
            expect(isCommandAllowed("rm -rf /")).toBe(false);
        });
    });
});

describe("allowlist — isShellBypass", () => {
    it("returns false for non-shell base commands", () => {
        expect(isShellBypass("ls", ["-l"])).toBe(false);
        expect(isShellBypass("grep", ["-c", "rm -rf /"])).toBe(false);
    });

    it("returns false for shells without a -c flag", () => {
        expect(isShellBypass("bash", ["script.sh"])).toBe(false);
        expect(isShellBypass("zsh", ["-l"])).toBe(false);
    });

    it("returns true when a shell runs a destructive inline command", () => {
        expect(isShellBypass("bash", ["-c", "rm", "-rf", "/"])).toBe(true);
        expect(isShellBypass("zsh", ["-c", "echo", "x", ">", "/dev/sda"])).toBe(true);
        expect(isShellBypass("sh", ["-c", ":(){ :|:& };:"])).toBe(true);
    });

    it("returns false when the inline command is not destructive", () => {
        expect(isShellBypass("bash", ["-c", "ls", "-la"])).toBe(false);
        expect(isShellBypass("sh", ["-c", "echo", "hello"])).toBe(false);
    });

    it("covers all recognized shells", () => {
        for (const shell of ["bash", "sh", "zsh", "dash", "fish", "cmd", "powershell"]) {
            expect(isShellBypass(shell, ["-c", "rm", "-rf", "/"])).toBe(true);
        }
    });

    it("handles a full shell path as base command", () => {
        // path.basename(...).split(" ")[0] strips the dir
        expect(isShellBypass("/bin/bash", ["-c", "rm", "-rf", "/"])).toBe(true);
        expect(isShellBypass("/usr/bin/zsh", ["-c", "ls"])).toBe(false);
    });

    it("rejects non-shell binaries with -c (e.g. gcc -c file.c)", () => {
        expect(isShellBypass("gcc", ["-c", "rm", "-rf", "/"])).toBe(false);
    });
});

describe("allowlist — critical system path protection", () => {
    describe("isCriticalSystemPath", () => {
        it("matches Unix/macOS critical files", () => {
            expect(isCriticalSystemPath("/etc/passwd")).toBe(true);
            expect(isCriticalSystemPath("/etc/shadow")).toBe(true);
            expect(isCriticalSystemPath("/etc/sudoers")).toBe(true);
        });

        it("matches directories and their descendants", () => {
            expect(isCriticalSystemPath("/boot")).toBe(true);
            expect(isCriticalSystemPath("/boot/grub/grub.cfg")).toBe(true);
            expect(isCriticalSystemPath("/System/Library")).toBe(true);
            expect(isCriticalSystemPath("/System/Library/Frameworks")).toBe(true);
            expect(isCriticalSystemPath("/usr/bin")).toBe(true);
            expect(isCriticalSystemPath("/usr/bin/curl")).toBe(true);
            expect(isCriticalSystemPath("/sbin")).toBe(true);
            expect(isCriticalSystemPath("/bin")).toBe(true);
            expect(isCriticalSystemPath("/var/root")).toBe(true);
            expect(isCriticalSystemPath("/private/etc")).toBe(true);
        });

        it("is case-insensitive (Windows-style comparison)", () => {
            // The function lowercases both sides.
            expect(isCriticalSystemPath("/ETC/PASSWD")).toBe(true);
            expect(isCriticalSystemPath("/Etc/Passwd")).toBe(true);
        });

        it("does NOT match non-critical paths", () => {
            expect(isCriticalSystemPath("/tmp")).toBe(false);
            expect(isCriticalSystemPath("/tmp/junk.txt")).toBe(false);
            expect(isCriticalSystemPath("/Users/me")).toBe(false);
            expect(isCriticalSystemPath("/var/log/app.log")).toBe(false);
            expect(isCriticalSystemPath("/opt/app/data")).toBe(false);
        });

        it("on macOS, /etc symlink IS followed to /private/etc (TOCTOU fix)", () => {
            // /etc is a symlink to private/etc on macOS. Post-fix, realResolve
            // follows it, and CRITICAL_SYSTEM_PATHS lists /private/etc
            // wholesale, so /etc/myapp.conf is correctly classified as
            // inside a critical tree (before this was a blindspot).
            if (process.platform === "darwin") {
                expect(isCriticalSystemPath("/etc/myapp.conf")).toBe(true);
                expect(isCriticalSystemPath("/etc/passwd2")).toBe(true);
            }
        });

        it("does NOT match sibling paths via prefix (no separator) on non-symlinked trees", () => {
            // Use a critical root that isn't a macOS symlink target.
            // /usr/bin is literal /usr/bin on both mac and linux; /usr/binutils
            // must NOT match.
            expect(isCriticalSystemPath("/usr/binutils")).toBe(false);
            // /bin vs /bin-backup — /bin is literal on all unixes.
            expect(isCriticalSystemPath("/bin-backup")).toBe(false);
        });
    });

    describe("isPathAllowed / getPathBlockedReason", () => {
        it("allows everything except critical system paths", () => {
            expect(isPathAllowed("/tmp/foo")).toBe(true);
            expect(isPathAllowed("/Users/me/code")).toBe(true);
            expect(isPathAllowed("/etc/passwd")).toBe(false);
        });

        it("returns a descriptive reason only for disallowed paths", () => {
            expect(getPathBlockedReason("/tmp/foo")).toBeNull();
            const reason = getPathBlockedReason("/etc/passwd");
            expect(reason).not.toBeNull();
            expect(reason!).toMatch(/critical operating-system path/);
            expect(reason!).toContain("/etc/passwd");
        });
    });
});

describe("allowlist — network / domain allowlist", () => {
    it("allows known API domains", () => {
        expect(isDomainAllowed("api.openai.com")).toBe(true);
        expect(isDomainAllowed("api.anthropic.com")).toBe(true);
        expect(isDomainAllowed("openrouter.ai")).toBe(true);
    });

    it("treats www. as an alias: bare 'google.com' is allowed via www.google.com", () => {
        // Module checks ALLOWED_DOMAINS.has(`www.${domain}`) as a fallback.
        expect(isDomainAllowed("google.com")).toBe(true);
    });

    it("rejects unknown domains", () => {
        expect(isDomainAllowed("attacker.com")).toBe(false);
        expect(isDomainAllowed("data-exfil.io")).toBe(false);
        expect(isDomainAllowed("")).toBe(false);
    });

    it("is case-sensitive on exact domain match", () => {
        // Domains are canonically lowercase; an uppercase variant is not
        // in the Set and won't match. Confirms caller is responsible for
        // normalization before calling this.
        expect(isDomainAllowed("API.OPENAI.COM")).toBe(false);
    });
});
