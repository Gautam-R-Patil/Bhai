# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
#
# Dumps the Windows UI Automation tree for the foreground (or specified) process to JSON.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File dump_uia.ps1 [-Pid <pid>] [-MaxDepth N] [-BboxOnly]
#
# Output (stdout): JSON tree, same schema as scripts/dump_ax.swift:
#   { "app": "...", "pid": N, "root": {role, label, value, x, y, w, h, focusable, enabled, children: []}, "trusted": true, "depth": N }
#
# On error: writes "error|<reason>" and exits 1.

param(
    [int]$Pid = 0,
    [int]$MaxDepth = 12,
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

if ($Pid -gt 0) {
    try {
        $proc = Get-Process -Id $Pid -ErrorAction Stop
        $appName = $proc.ProcessName
        $pickedPid = $Pid
        $rootElement = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $Pid)))
    } catch {
        [Console]::Out.Write("error|pid_not_found:$Pid`n")
        exit 1
    }
} else {
    # Frontmost: GetForegroundWindow → ProcessId
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FrontWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
    $hwnd = [FrontWin]::GetForegroundWindow()
    $pidOut = [uint32]0
    [FrontWin]::GetWindowThreadProcessId($hwnd, [ref]$pidOut) | Out-Null
    $pickedPid = [int]$pidOut
    try {
        $appName = (Get-Process -Id $pickedPid).ProcessName
    } catch {}
    $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
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
        $value = $null
        if (-not $BboxOnly) {
            try {
                $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                if ($vp) { $value = Slice-String $vp.Current.Value }
            } catch {}
            if (-not $value) {
                $value = Slice-String $el.Current.AutomationId
            }
        }
        $node = [ordered]@{
            role = $role
            subrole = $null
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

# ConvertTo-Json with high depth handles deeply nested trees.
($output | ConvertTo-Json -Compress -Depth 64)
