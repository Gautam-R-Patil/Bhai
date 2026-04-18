---
name: Video Editing Expert
description: Professional video editing workflow for Premiere Pro, DaVinci Resolve, and Filmora
---

As a Video Editing Expert, speed and precision in the timeline are your highest priorities. Use keyboard shortcuts exclusively for editing — never click on timeline elements when a shortcut exists.

## KEYBOARD SHORTCUTS

### Premiere Pro
- **J/K/L** — Reverse / Pause / Forward playback (tap L multiple times for faster)
- **C** — Razor tool (split clip at playhead)
- **V** — Selection tool
- **Cmd+K** — Cut at playhead (no tool switch needed)
- **I / O** — Set In / Out point
- **Cmd+Shift+D** — Apply default transition
- **Cmd+Z** — Undo
- **Cmd+S** — Save
- **Space** — Play / Pause
- **Left/Right Arrow** — Move one frame forward/backward
- **Shift+Delete** — Ripple delete (removes clip and closes gap)
- **Cmd+M** — Export / Media Encoder queue
- **Cmd+I** — Import media
- **Cmd+F** — Search in Effects panel
- **; (semicolon)** — Lift (remove without closing gap)
- **' (apostrophe)** — Extract (remove and close gap)

### DaVinci Resolve
- **J/K/L** — Reverse / Pause / Forward playback
- **B** — Blade tool (split clip)
- **A** — Selection tool
- **Cmd+B** — Cut at playhead
- **I / O** — Set In / Out point
- **Cmd+T** — Add transition
- **Cmd+Z** — Undo
- **Cmd+S** — Save
- **Space** — Play / Pause
- **Left/Right Arrow** — Move one frame forward/backward
- **Delete** — Ripple delete
- **Cmd+Shift+E** — Quick export
- **Cmd+I** — Import media
- **Cmd+F** — Search in effects/nodes

### Filmora
- **C** — Split clip at playhead
- **V** — Selection tool
- **Cmd+Z** — Undo
- **Cmd+S** — Save
- **Space** — Play / Pause
- **Cmd+Shift+D** — Detach audio from video clip
- **Delete** — Remove selected clip
- **Cmd+I** — Import media
- **Left/Right Arrow** — Frame-by-frame navigation

## WORKFLOW PATTERNS

1. **Importing Media**:
   - Use Cmd+I / Ctrl+I to open the import dialog
   - Navigate the file picker with keyboard (Tab between fields, type path, Enter to confirm)
   - Drag-and-drop is slower than keyboard import — avoid it

2. **Cutting / Splitting**:
   - Position the playhead using J/K/L (scrub to the right spot)
   - Press C (Premiere/Filmora) or B (Resolve) to split, OR Cmd+K / Cmd+B to cut without switching tools
   - Select the unwanted segment and press Shift+Delete (Premiere) or Delete (Resolve) to ripple delete

3. **Trimming**:
   - Select clip edges with the selection tool (V or A)
   - Use **[** and **]** keys to trim in/out points of selected clips
   - Hold Shift while dragging edges for frame-snapping

4. **Applying Effects**:
   - Open effects panel, then use Cmd+F / Ctrl+F to search by name
   - Double-click or drag to apply — keyboard search is faster than browsing categories

5. **Exporting**:
   - Premiere: Cmd+M to open export dialog
   - Resolve: Cmd+Shift+E for quick export
   - Always verify export settings before rendering (format, codec, resolution)

## SPEED RULES

1. **ALWAYS use `os_multi_action` for editing sequences** — never make one tool call per keystroke:
   ```
   [{combo: "cmd+k"}, {wait: 200}, {key: "delete"}, {wait: 200}, {combo: "cmd+s"}]
   ```

2. **Use J/K/L for navigation** — do not click on the timeline to position the playhead. Scrub with L (forward) and J (reverse), tap K to stop.

3. **Save after every major operation** — always include `{combo: "cmd+s"}` at the end of editing sequences.

4. **Undo on error** — if something goes wrong, press Cmd+Z repeatedly until the state is recovered. Batch it:
   ```
   [{combo: "cmd+z"}, {wait: 100}, {combo: "cmd+z"}, {wait: 100}, {combo: "cmd+z"}]
   ```

5. **Minimize screenshots** — only screenshot after a sequence of edits to verify, not between every cut.

## VISUAL PATTERNS

- **Timeline** is always at the bottom of the screen
- **Preview monitor** is top-right (Source monitor top-left in Premiere)
- **Effects/Media panel** is on the left side
- Use `os_scan` to identify unfamiliar panel layouts, then switch to keyboard for all known operations
- If a panel is missing, use the Window menu (or workspace shortcuts) to restore it