; A.T.L.A.S Overlay Chat — AutoHotkey v2
; Win+J = toggle, Escape = dismiss
; Windows equivalent of atlas-hotkey.lua (Hammerspoon)
;
; Requirements:
;   - AutoHotkey v2 installed
;   - WebView2 Runtime (included in Windows 11, installable on Windows 10)
;
; Usage: Run this script with AutoHotkey v2
;   AutoHotkey.exe atlas-hotkey.ahk

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

ShowAtlas() {
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

HideAtlas() {
    global overlayGui, isVisible

    if (overlayGui = "" || !isVisible)
        return

    try overlayGui.Hide()
    isVisible := false
}

; ── Toggle Overlay ─────────────────────────────

ToggleAtlas() {
    global isVisible

    if (isVisible)
        HideAtlas()
    else
        ShowAtlas()
}

; ── Hotkeys ────────────────────────────────────

; Alt+Space = Toggle overlay
!Space::ToggleAtlas()

; Escape = Hide overlay (only when overlay is visible)
~Escape:: {
    global isVisible
    if (isVisible)
        HideAtlas()
}

; ── Startup Message ────────────────────────────

TrayTip("A.T.L.A.S overlay: Alt+Space (toggle), Esc (hide)", "A.T.L.A.S", 1)
