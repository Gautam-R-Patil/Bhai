# Desktop Bundle Size — Analysis & Roadmap

Live notes on why the Electron app bundle is as large as it is, what's
already been trimmed, and what options exist for going further. The
audit originally claimed a **−600 MB** win by removing the bundled
`../node_modules` copy from `extraResources`. That claim is
**aspirational** — the real ceiling is much lower without a major
refactor.

## Why node_modules is bundled at all

The Electron app spawns the bot as a **child process** running
`node bot/dist/index.js`. That child sets `NODE_PATH` to its own
`bot/node_modules` and cannot share the Electron app's `node_modules`
because:

1. Electron ships its own V8, which uses different native-module
   builds of `better-sqlite3`, `sharp`, `onnxruntime-node`, etc.
   (Node vs Electron ABI.)
2. The Electron app has a totally different dep set (`electron`,
   `electron-builder`, `electron-store`, `electron-updater`,
   `bytenode`, `javascript-obfuscator`). The bot doesn't need any of
   those; the main process doesn't need `openai`, `baileys`,
   `googleapis`, `playwright`, etc.

Sharing wasn't free either way — so bundling stays.

## Actual size breakdown (dev machine, 1.3 GB total)

### Production deps ≥10 MB (all runtime-required)

| Package | Size | Why |
|---|---|---|
| `ffprobe-static` | 335 MB | 3 platforms × ~110 MB video metadata binary |
| `googleapis` | 194 MB | Gmail + Calendar + Drive + dozens more |
| `@xenova/transformers` | 67 MB | Embedding model + WASM runtime |
| `ffmpeg-static` | 44 MB | Current-platform ffmpeg binary |
| `convex` | 44 MB | Convex client SDK |
| `tree-sitter-typescript` | 37 MB | TS grammar for code indexing |
| `pdf-parse` | 34 MB | PDF text extraction |
| `pdf-lib` | 23 MB | PDF generation |
| `@google/genai` | 14 MB | Gemini SDK |
| `@whiskeysockets/baileys` | 13 MB | WhatsApp protocol |
| `fluent-ffmpeg` | 12 MB | ffmpeg wrapper |
| `better-sqlite3` | 12 MB | Native SQLite |
| `tree-sitter-rust` | 11 MB | Rust grammar (for multi-lang indexing) |

**Prod deps subtotal: ~850 MB.** Every item is actually imported by
`src/` at runtime. Removing any of them means removing a feature.

### Dev deps (already excluded from bundle)

| Package | Size | Status |
|---|---|---|
| `typescript` | 23 MB | filter excludes by name |
| `vitest` + `@vitest/ui` | ~3 MB | filter |
| `@biomejs/biome` | <1 MB | filter |
| `@types/*` | ~5 MB total | filter |
| `archiver`, `tsx`, `jsdom`, etc. | <2 MB | filter |

**Dev dep savings: ~30 MB.** Already in `desktop/package.json`.

### Platform-specific binaries (trimmed per target)

| Package | Full | Target only | Savings |
|---|---|---|---|
| `ffprobe-static` | 335 MB | 132 MB (darwin) / 104 MB (win32) | ~200-230 MB |
| `onnxruntime-node` | 91 MB | 43 MB (darwin) / 18 MB (win32) | ~48-73 MB |

**Per-build savings: ~250-300 MB.** Wired via
`mac.extraResources` / `win.extraResources` overrides.

## What's already saved

| Technique | Saving |
|---|---|
| Dev-dep name filter | ~30 MB |
| Tests / examples / docs / *.md strip | ~20-40 MB |
| Per-platform `bin/` filter for ffprobe + onnxruntime | ~250-300 MB per build |
| **Total current reduction vs raw `**/*`** | **~300-370 MB** |

So the current mac DMG is already ~1 GB smaller than a naive
`"**/*"` bundle would have been.

## What could save more (in increasing order of effort)

1. **Replace `googleapis` with per-API `@google-cloud/*` clients**
   (low risk, medium effort — touches every google-api.ts import site)
   — potential savings ~150-180 MB.

2. **esbuild-bundle the bot entry into a single file**
   (high effort — existing build uses `tsc`; switching to esbuild
   means re-validating native-module handling, source-map strategy,
   and the `dist/` output contract used by `desktop/main.js`)
   — potential savings: most pure-JS transitive deps drop out,
   remaining footprint would be just the native-dep node_modules
   (`better-sqlite3`, `sharp`, `onnxruntime-node`,
   `@whiskeysockets/baileys`, tree-sitter-*, `ffmpeg-static`,
   `ffprobe-static`) — plausibly ~400-500 MB trimmed beyond today.

3. **First-run `npm install --omit=dev`** into `bot/node_modules`
   from a shipped `package.json`
   (ships only package.json; installs prod deps on first launch)
   — saves ~1 GB download/disk at install time, but adds network
   requirement + ~30-60 s first-launch delay.

4. **Replace `@xenova/transformers` with a thinner ONNX runtime**
   (already considered and rejected — the transformers lib handles
   tokenization + pipelines that would have to be re-implemented).

## TL;DR

The audit's **−600 MB** line was "if you could remove the entire
bundled copy." You can't — ~850 MB of prod deps are genuinely
needed at runtime. The three levers that moved the needle:

- Dev-dep filter: ~30 MB ✅ done
- `tests/` + `docs/` strip: ~30 MB ✅ done
- Per-platform binary filter: ~250-300 MB per build ✅ done

Anything bigger requires architectural work (path 1 or 2 above).
Evaluate when disk/bandwidth pressure makes the cost worth it; not
an automatic win.
