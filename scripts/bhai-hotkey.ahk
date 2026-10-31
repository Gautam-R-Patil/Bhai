; Bhai Overlay Chat — AutoHotkey v2
; Win+J = toggle, Escape = dismiss
; Windows equivalent of bhai-hotkey.lua (Hammerspoon)
;
; Requirements:
;   - AutoHotkey v2 installed
;   - WebView2 Runtime (included in Windows 11, installable on Windows 10)
;
; Usage: Run this script with AutoHotkey v2
;   AutoHotkey.exe bhai-hotkey.ahk

#Requires AutoHotkey v2.0
#SingleInstance Force

; ── Configuration ──────────────────────────────

OVERLAY_URL := "http://127.0.0.1:18792"
MAX_WIDTH := 340
MAX_HEIGHT := 500
MIN_HEIGHT := 56

overlayGui := ""
isVisible := false

; ── Show Overlay ───────────────────────────────

ShowBhai() {
    global overlayGui, isVisible, OVERLAY_URL, MAX_WIDTH, MIN_HEIGHT

    ; Close existing overlay if any
    if (overlayGui != "") {
        try overlayGui.Destroy()
        overlayGui := ""
    }

    ; Get screen dimensions
    MonitorGetWorkArea(MonitorGetPrimary(), &mLeft, &mTop, &mRight, &mBottom)
    xPos := mRight - MAX_WIDTH - 16
    yPos := mTop + 8

    ; Create new GUI
    overlayGui := Gui("+AlwaysOnTop -Caption +ToolWindow")
    overlayGui.BackColor := "000000"
    WinSetTransColor("000000", overlayGui)

    ; Add WebView2 or fallback to ActiveX WebBrowser
    try {
        ; Try to use a browser control
        wb := overlayGui.Add("ActiveX", "x0 y0 w" MAX_WIDTH " h" MIN_HEIGHT, "Shell.Explorer")
        wb.Navigate(OVERLAY_URL)
    } catch {
        ; Fallback: just open in default browser
        Run(OVERLAY_URL)
        return
    }

    overlayGui.Show("x" xPos " y" yPos " w" MAX_WIDTH " h" MIN_HEIGHT " NoActivate")
    isVisible := true

    ; Focus the overlay
    WinActivate("ahk_id " overlayGui.Hwnd)
}

; ── Hide Overlay ───────────────────────────────

HideBhai() {
    global overlayGui, isVisible

    if (overlayGui = "" || !isVisible)
        return

    try overlayGui.Hide()
    isVisible := false
}

; ── Toggle Overlay ─────────────────────────────

ToggleBhai() {
    global isVisible

    if (isVisible)
        HideBhai()
    else
        ShowBhai()
}

; ── Hotkeys ────────────────────────────────────

; Alt+Space = Toggle overlay
!Space::ToggleBhai()

; Escape = Hide overlay (only when overlay is visible)
~Escape:: {
    global isVisible
    if (isVisible)
        HideBhai()
}

; ── Startup Message ────────────────────────────

TrayTip("Bhai overlay: Alt+Space (toggle), Esc (hide)", "Bhai", 1)
