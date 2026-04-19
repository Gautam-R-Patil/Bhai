# Setup Components

Vanilla-JS component library for the redesigned setup wizard and Ready Hub.

Each component is a single IIFE file that:

- Attaches its constructor to `window.SetupComponents.<Name>` for browser use.
- Exports pure helpers and the class via `module.exports = { ... }` for vitest.
- Builds DOM via `document.createElement` + `textContent` (no `innerHTML`).

## Inventory

| File | Class | Consumed by |
|---|---|---|
| `status-tile.js` | `StatusTile` | Ready Hub tiles (Phase D1) |
| `permissions-grid.js` | `PermissionsGrid` | Wizard Permissions step (C7) + Ready Hub tile (D1) |
| `hotkey-picker.js` | `HotkeyPicker` | Wizard Personalize step (C6) |
| `voice-picker.js` | `VoicePicker` | Wizard Personalize step (C6) |
| `theme-switch.js` | `ThemeSwitch` | Wizard Personalize step (C6) |
| `channel-card.js` | `ChannelCard` | Channels picker (D6) + Ready Hub Channels tile (D1) |
| `install-log.js` | `InstallLog` | Wizard Install step (C11) |

All components load via `components.css` which `wizard.html` and `panel.html` both link.

## Smoke page

In dev, `npm start` to launch the desktop app. When the wizard window opens, open DevTools on it (Cmd+Opt+I on macOS) and navigate to the smoke page:

```js
location.href = "file:///Users/user/Desktop/ATLAS/.claude/worktrees/wizard-redesign/desktop/components/_smoke.html";
```

Use the absolute path for your machine; the `file://` scheme is needed so the relative `../styles.css` and `components.css` links resolve.

Every component mounts once with plausible props. Expect:

- Zero console errors.
- Zero 404s in the Network tab.
- Each component renders visibly.
- Buttons respond to clicks (hotkey records, voice preview plays, theme pills toggle, channel Test surfaces a "Test failed" if no creds).

## Tests

```bash
cd desktop && npm test
```

Runs the whole vitest suite for `desktop/` — pure helpers and jsdom DOM tests for every component.
