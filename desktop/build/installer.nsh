; Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
; Custom NSIS installer include — show install details/log panel
; so users can see that the installer is actively working.

; ── Show the details log panel ─────────────────────────
; By default electron-builder hides this, making the installer
; look stuck during the large (~200MB) file extraction.
ShowInstDetails show

; ── Custom install section (runs after file extraction) ──
!macro customInstall
  ; Re-enable detail printing for post-extraction steps
  SetDetailsPrint textonly

  DetailPrint ""
  DetailPrint "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  DetailPrint "All application files extracted."
  DetailPrint "Registering shortcuts and file associations..."
!macroend

; ── Custom uninstall section (wipe all data) ───────
!macro customUnInstall
  DetailPrint "Wiping Bhai data and configurations..."
!macroend

!macro customRemoveFiles
  ; 1. Delete the desktop app's configuration folder (electron-store, logs)
  RMDir /r "$APPDATA\bhai-desktop"
  
  ; 2. Delete the bot's data directory (SQLite DB, embeddings, etc.)
  RMDir /r "$LOCALAPPDATA\Programs\Bhai\resources\bot\data"
  
  ; 3. Delete the entire installation folder just to be absolutely sure
  RMDir /r "$LOCALAPPDATA\Programs\Bhai"
!macroend
