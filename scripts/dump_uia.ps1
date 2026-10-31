# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
#
# Dumps the Windows UI Automation tree for the foreground (or specified) process to JSON.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File dump_uia.ps1 [-TargetPid <pid>] [-MaxDepth N] [-BboxOnly]
#
# Output (stdout): JSON tree, same schema as scripts/dump_ax.swift:
#   { "app": "...", "pid": N, "root": {role, label, value, x, y, w, h, focusable, enabled, children: []}, "trusted": true, "depth": N }
#
# On error: writes "error|<reason>" and exits 1.

param(
    # Not -Pid: $Pid is PowerShell's read-only automatic $PID, and a parameter of that name
    # fails with "Cannot overwrite variable PID", so every app-targeted dump errored.
    [int]$TargetPid = 0,
    [int]$MaxDepth = 20,  # raised from 12 — modern apps can be 25-40 deep
    [switch]$BboxOnly
)

$ErrorActionPreference = "Stop"

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write("error|uia_not_available:$($_.Exception.Message)`n")
    exit 1
}

# ── Pick target ─────────────────────────────────

$rootElement = $null
$pickedPid = 0
$appName = "unknown"

if ($TargetPid -gt 0) {
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction Stop
        $appName = $proc.ProcessName
        $pickedPid = $TargetPid
        $rootElement = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)))
    } catch {
        [Console]::Out.Write("error|pid_not_found:$TargetPid`n")
        exit 1
    }
} else {
    # Frontmost: GetForegroundWindow → ProcessId. Guard against duplicate Add-Type errors
    # when run in a long-lived PowerShell session.
    if (-not ([System.Management.Automation.PSTypeName]'FrontWin').Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FrontWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
    }
    $hwnd = [FrontWin]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) {
        [Console]::Out.Write("error|no_foreground_window`n")
        exit 1
    }
    $pidOut = [uint32]0
    [FrontWin]::GetWindowThreadProcessId($hwnd, [ref]$pidOut) | Out-Null
    $pickedPid = [int]$pidOut
    try {
        $appName = (Get-Process -Id $pickedPid).ProcessName
    } catch {}
    try {
        $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    } catch {
        [Console]::Out.Write("error|fromhandle_failed:$($_.Exception.Message)`n")
        exit 1
    }
}

if (-not $rootElement) {
    [Console]::Out.Write("error|no_root_element`n")
    exit 1
}

# ── Walk ───────────────────────────────────────

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Slice-String([string]$s, [int]$max = 200) {
    if (-not $s) { return $null }
    if ($s.Length -le $max) { return $s }
    return $s.Substring(0, $max)
}

function Walk-Node($el, [int]$depth) {
    if (-not $el -or $depth -gt $MaxDepth) { return $null }
    try {
        $r = $el.Current.BoundingRectangle
        $role = $el.Current.ControlType.ProgrammaticName
        if ($role) { $role = ($role -replace 'ControlType\.', '') }
        $label = Slice-String $el.Current.Name
        $isPassword = $false
        try { $isPassword = [bool]$el.Current.IsPassword } catch {}
        $value = $null
        if (-not $BboxOnly) {
            if ($isPassword) {
                # SECURITY: don't expose password contents
                $value = "[secure]"
            } else {
                try {
                    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($vp) { $value = Slice-String $vp.Current.Value }
                } catch {}
                # Note: do NOT fall back to AutomationId — it's a developer-assigned identifier,
                # not a user-visible value. Putting it in `value` causes false positives in label search.
            }
        }
        # Capture AutomationId separately so the LLM can reason about it without confusion.
        $automationId = $null
        try { $automationId = Slice-String $el.Current.AutomationId } catch {}
        $node = [ordered]@{
            role = $role
            subrole = $automationId  # repurpose subrole field for AutomationId (was always null on Windows)
            label = $label
            value = $value
            x = [int]$r.X
            y = [int]$r.Y
            w = [int]$r.Width
            h = [int]$r.Height
            focusable = [bool]$el.Current.IsKeyboardFocusable
            enabled = [bool]$el.Current.IsEnabled
            children = @()
        }
        $c = $walker.GetFirstChild($el)
        while ($c) {
            $kid = Walk-Node $c ($depth + 1)
            if ($kid) { $node.children += $kid }
            $c = $walker.GetNextSibling($c)
        }
        return $node
    } catch {
        return $null
    }
}

$root = Walk-Node $rootElement 0
if (-not $root) {
    [Console]::Out.Write("error|walk_failed`n")
    exit 1
}

$output = [ordered]@{
    app = $appName
    pid = $pickedPid
    root = $root
    trusted = $true
    depth = $MaxDepth
}

# ConvertTo-Json: raise depth to 100 to avoid silent truncation on deep app trees
# (PowerShell stringifies objects past the depth limit to e.g. "System.Collections.Hashtable").
($output | ConvertTo-Json -Compress -Depth 100)
