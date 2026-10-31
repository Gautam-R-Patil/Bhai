# CREDITS

Bhai is built by **XAGI Labs Private Limited** and uses the following open-source libraries.
We gratefully acknowledge their authors and communities.

---

## Core Runtime

| Package | License | Description |
|---------|---------|-------------|
| [Node.js](https://nodejs.org) | MIT | JavaScript runtime |
| [TypeScript](https://www.typescriptlang.org) (`typescript`) | Apache-2.0 | Type-safe JavaScript |

## AI & LLM

| Package | License | Description |
|---------|---------|-------------|
| [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) (`@anthropic-ai/sdk`) | MIT | Claude API types and client (the Convex proxy calls Claude)|
| [OpenAI Node SDK](https://github.com/openai/openai-node) (`openai`) | Apache-2.0 | LLM API client |
| [Google GenAI](https://github.com/googleapis/js-genai) (`@google/genai`) | Apache-2.0 | Google Generative AI SDK (Gemini Live + multimodal) |
| [Xenova Transformers](https://github.com/xenova/transformers.js) (`@xenova/transformers`) | Apache-2.0 | Local embedding and transformer models |
| [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Apache-2.0 | Newer Transformers.js fork (cross-encoder rerank, Kokoro TTS) |
| [Kokoro.js](https://github.com/hexgrad/kokoro) (`kokoro-js`) | Apache-2.0 | Local in-process Kokoro TTS for offline voice synthesis |
| [Convex](https://github.com/get-convex/convex-js) (`convex`) | Apache-2.0 | Reactive backend client |

## Messaging & Channels

| Package | License | Description |
|---------|---------|-------------|
| [grammY](https://grammy.dev) (`grammy`) | MIT | Telegram Bot framework |
| [discord.js](https://discord.js.org) (`discord.js`) | Apache-2.0 | Discord bot library |
| [Slack Bolt](https://slack.dev/bolt-js) (`@slack/bolt`) | MIT | Slack app framework |
| [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys`) | MIT | WhatsApp Web API |

## Google & APIs

| Package | License | Description |
|---------|---------|-------------|
| [Google Calendar API](https://github.com/googleapis/google-api-nodejs-client) (`@googleapis/calendar`) | Apache-2.0 | Google Calendar client |
| [Gmail API](https://github.com/googleapis/google-api-nodejs-client) (`@googleapis/gmail`) | Apache-2.0 | Gmail client |
| [Google OAuth2 API](https://github.com/googleapis/google-api-nodejs-client) (`@googleapis/oauth2`) | Apache-2.0 | Google account info |
| [Google Tasks API](https://github.com/googleapis/google-api-nodejs-client) (`@googleapis/tasks`) | Apache-2.0 | Google Tasks client |
| [YouTube Data API](https://github.com/googleapis/google-api-nodejs-client) (`@googleapis/youtube`) | Apache-2.0 | YouTube client |
| [Google Auth Library](https://github.com/googleapis/google-auth-library-nodejs) (`google-auth-library`) | Apache-2.0 | OAuth2 sign-in and tokens |

## Database & Storage

| Package | License | Description |
|---------|---------|-------------|
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (`better-sqlite3`) | MIT | SQLite3 bindings for Node.js |
| [Supabase JS](https://github.com/supabase/supabase-js) (`@supabase/supabase-js`) | MIT | Supabase client |

## Browser Automation

| Package | License | Description |
|---------|---------|-------------|
| [Playwright](https://playwright.dev) (`playwright-core`) | Apache-2.0 | Browser automation (Chromium backend) |

## Email

| Package | License | Description |
|---------|---------|-------------|
| [IMAPFlow](https://github.com/postalsys/imapflow) (`imapflow`) | MIT | Modern IMAP client |
| [Nodemailer](https://nodemailer.com) (`nodemailer`) | MIT | Email sending (SMTP) |

## Web & Networking

| Package | License | Description |
|---------|---------|-------------|
| [Express](https://expressjs.com) (`express`) | MIT | Web server framework |
| [ws](https://github.com/websockets/ws) (`ws`) | MIT | WebSocket client & server |
| [web-push](https://github.com/web-push-libs/web-push) (`web-push`) | MPL-2.0 | Web Push notifications |

## Media & Video

| Package | License | Description |
|---------|---------|-------------|
| [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) (`fluent-ffmpeg`) | MIT | FFmpeg command builder and runner |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) (`ffmpeg-static`) | GPL-3.0 | Static FFmpeg binaries |
| [ffprobe-static](https://github.com/joshwnj/ffprobe-static) (`ffprobe-static`) | MIT | Static FFprobe binaries |
| [Sharp](https://sharp.pixelplumbing.com) (`sharp`) | Apache-2.0 | High-performance image processing |
| [pdf-parse](https://gitlab.com/autokent/pdf-parse) (`pdf-parse`) | MIT | PDF text extraction |
| [unpdf](https://github.com/unjs/unpdf) (`unpdf`) | MIT | PDF utilities for Node.js and browsers |

## Documents & Presentations

| Package | License | Description |
|---------|---------|-------------|
| [docx](https://github.com/dolanmiu/docx) (`docx`) | MIT | Generate `.docx` Word documents |
| [docxtemplater](https://github.com/open-xml-templating/docxtemplater) (`docxtemplater`) | MIT | Templated Word document generation |
| [PizZip](https://github.com/open-xml-templating/pizzip) (`pizzip`) | MIT | Synchronous zip library for docxtemplater |
| [pptxgenjs](https://github.com/gitbrent/PptxGenJS) (`pptxgenjs`) | MIT | Generate PowerPoint `.pptx` presentations |
| [pdf-lib](https://pdf-lib.js.org) (`pdf-lib`) | MIT | Create and modify PDF documents |
| [resumed](https://github.com/rbardini/resumed) (`resumed`) | MIT | JSON Resume renderer |
| [markdown-it](https://github.com/markdown-it/markdown-it) (`markdown-it`) | MIT | Markdown parser and renderer |

## Code Analysis

| Package | License | Description |
|---------|---------|-------------|
| [tree-sitter](https://github.com/tree-sitter/node-tree-sitter) (`tree-sitter`) | MIT | Incremental parser library (Node bindings) |
| [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) (`tree-sitter-typescript`) | MIT | TypeScript/TSX grammar |
| [tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) (`tree-sitter-python`) | MIT | Python grammar |
| [tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) (`tree-sitter-rust`) | MIT | Rust grammar |
| [tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) (`tree-sitter-go`) | MIT | Go grammar |

## Social & Marketing

| Package | License | Description |
|---------|---------|-------------|
| [twitter-api-v2](https://github.com/PLhery/node-twitter-api-v2) (`twitter-api-v2`) | Apache-2.0 | Twitter/X API v2 client |
| [apify-client](https://github.com/apify/apify-client-js) (`apify-client`) | Apache-2.0 | Apify scraping platform client |

## DevOps & Containers

| Package | License | Description |
|---------|---------|-------------|
| [Dockerode](https://github.com/apocas/dockerode) (`dockerode`) | Apache-2.0 | Docker API client |

## MCP (Model Context Protocol)

| Package | License | Description |
|---------|---------|-------------|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP server/client SDK |

## Utilities

| Package | License | Description |
|---------|---------|-------------|
| [dotenv](https://github.com/motdotla/dotenv) (`dotenv`) | BSD-2-Clause | Environment variable loader |
| [node-cron](https://github.com/node-cron/node-cron) (`node-cron`) | ISC | Cron job scheduler |
| [gray-matter](https://github.com/jonschlinkert/gray-matter) (`gray-matter`) | MIT | Front-matter parser |
| [Zod](https://zod.dev) (`zod`) | MIT | TypeScript-first schema validation |
| [tar](https://github.com/isaacs/node-tar) (`tar`) | ISC | Archive creation and extraction |
| [acorn](https://github.com/acornjs/acorn) (`acorn`) | MIT | JavaScript parser (Skill Forge compile check) |
| [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) (`proper-lockfile`) | MIT | Cross-process file locking |
| [psl](https://github.com/lupomontero/psl) (`psl`) | MIT | Public Suffix List parsing (domain scoping) |
| [@hapi/boom](https://github.com/hapijs/boom) (`@hapi/boom`) | BSD-3-Clause | HTTP-friendly error objects |
| [clipboardy](https://github.com/sindresorhus/clipboardy) (`clipboardy`) | MIT | Cross-platform clipboard access |
| [screenshot-desktop](https://github.com/bencevans/screenshot-desktop) (`screenshot-desktop`) | MIT | Cross-platform desktop screenshot capture |
| [winreg2](https://github.com/kessler/node-winreg) (`winreg2`) | BSD-2-Clause | Windows registry access |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) (`qrcode-terminal`) | Apache-2.0 | QR code display in terminal |

## Development

| Package | License | Description |
|---------|---------|-------------|
| [Biome](https://biomejs.dev) (`@biomejs/biome`) | MIT | Linter and formatter |
| [tsx](https://github.com/privatenumber/tsx) (`tsx`) | MIT | TypeScript execute & watch |
| [Vitest](https://vitest.dev) (`vitest`) | MIT | Fast unit testing framework |
| [Vitest UI](https://vitest.dev) (`@vitest/ui`) | MIT | Browser UI for Vitest |
| [archiver](https://github.com/archiverjs/node-archiver) (`archiver`) | MIT | Streaming zip/tar archive creation |
| [AWS SDK for JavaScript v3 — S3 Client](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-s3`) | Apache-2.0 | Used by release/distribution scripts for S3-compatible storage |
| [AWS SDK for JavaScript v3 — lib-storage](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/lib-storage`) | Apache-2.0 | Multipart upload helpers for the S3 client |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for Node.js |
| [@types/archiver](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for archiver |
| [@types/better-sqlite3](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for better-sqlite3 |
| [@types/dockerode](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for dockerode |
| [@types/express](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for Express |
| [@types/fluent-ffmpeg](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for fluent-ffmpeg |
| [@types/markdown-it](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for markdown-it |
| [@types/node-cron](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for node-cron |
| [@types/proper-lockfile](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for proper-lockfile |
| [@types/tar](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for tar |
| [@types/ws](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Type definitions for ws |

## Desktop app (`desktop/`)

| Package | License | Description |
|---------|---------|-------------|
| [Electron](https://www.electronjs.org) (`electron`) | MIT | Desktop shell |
| [electron-builder](https://www.electron.build) (`electron-builder`) | MIT | Packaging and installers |
| [electron-updater](https://www.electron.build/auto-update) (`electron-updater`) | MIT | Auto-update |
| [electron-store](https://github.com/sindresorhus/electron-store) (`electron-store`) | MIT | Persistent settings |
| [adm-zip](https://github.com/cthackers/adm-zip) (`adm-zip`) | MIT | Zip extraction |
| [qrcode](https://github.com/soldair/node-qrcode) (`qrcode`) | MIT | QR code rendering (WhatsApp linking) |
| [esbuild](https://esbuild.github.io) (`esbuild`) | MIT | Bot bundle |
| [bytenode](https://github.com/bytenode/bytenode) (`bytenode`) | MIT | V8 bytecode compilation |
| [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) (`javascript-obfuscator`) | BSD-2-Clause | Release obfuscation |
| [jsdom](https://github.com/jsdom/jsdom) (`jsdom`) | MIT | DOM tests |

The desktop app also uses better-sqlite3 and Vitest, and loads Baileys and imapflow from the bundled bot (all listed above).

## Web portals (`portals/`)

The admin panel and developer portal are separate Next.js apps.

| Package | License | Description |
|---------|---------|-------------|
| [Next.js](https://nextjs.org) (`next`) | MIT | React framework |
| [React](https://react.dev) (`react`, `react-dom`) | MIT | UI library |
| [Tailwind CSS](https://tailwindcss.com) (`tailwindcss`) | MIT | Utility-first CSS |
| [PostCSS](https://postcss.org) (`postcss`) | MIT | CSS processing |
| [Autoprefixer](https://github.com/postcss/autoprefixer) (`autoprefixer`) | MIT | Vendor prefixes |
| [Lucide](https://lucide.dev) (`lucide-react`) | ISC | Icons |
| [jose](https://github.com/panva/jose) (`jose`) | MIT | JWT signing and verification |
| [bcrypt.js](https://github.com/dcodeIO/bcrypt.js) (`bcryptjs`) | MIT | Password hashing |
| [date-fns](https://date-fns.org) (`date-fns`) | MIT | Date utilities (admin panel) |
| [Recharts](https://recharts.org) (`recharts`) | MIT | Charts (admin panel) |
| [react-dropzone](https://react-dropzone.js.org) (`react-dropzone`) | MIT | File uploads (developer portal) |
| [react-markdown](https://github.com/remarkjs/react-markdown) (`react-markdown`) | MIT | Markdown rendering (developer portal) |

Both portals also use Convex, TypeScript and Vitest (listed above).

---

## Native Rust Dependencies (`native/`)

The native performance layer is built in Rust via napi-rs. It links the following crates:

| Crate | License | Description |
|-------|---------|-------------|
| [napi](https://github.com/napi-rs/napi-rs) (`napi`) | MIT | Rust bindings for Node.js N-API |
| [napi-derive](https://github.com/napi-rs/napi-rs) (`napi-derive`) | MIT | Procedural macros for napi-rs |
| [napi-build](https://github.com/napi-rs/napi-rs) (`napi-build`) | MIT | Build-script helpers for napi-rs |
| [wide](https://github.com/Lokathor/wide) (`wide`) | Zlib OR Apache-2.0 OR MIT | Portable SIMD abstractions |
| [simsimd](https://github.com/ashvardanian/SimSIMD) (`simsimd`) | Apache-2.0 | High-performance similarity metrics |
| [rayon](https://github.com/rayon-rs/rayon) (`rayon`) | MIT OR Apache-2.0 | Data-parallelism library |
| [parking_lot](https://github.com/Amanieu/parking_lot) (`parking_lot`) | MIT OR Apache-2.0 | Fast synchronization primitives |
| [regex](https://github.com/rust-lang/regex) (`regex`) | MIT OR Apache-2.0 | Regular expressions |
| [lazy_static](https://github.com/rust-lang-nursery/lazy-static.rs) (`lazy_static`) | MIT OR Apache-2.0 | Lazy-initialized statics |
| [serde](https://github.com/serde-rs/serde) (`serde`) | MIT OR Apache-2.0 | Serialization framework |
| [serde_json](https://github.com/serde-rs/json) (`serde_json`) | MIT OR Apache-2.0 | JSON serialization |
| [once_cell](https://github.com/matklad/once_cell) (`once_cell`) | MIT OR Apache-2.0 | Single-assignment cells and lazy values |
| [aes-gcm](https://github.com/RustCrypto/AEADs) (`aes-gcm`) | MIT OR Apache-2.0 | AES-256-GCM authenticated encryption |
| [scrypt](https://github.com/RustCrypto/password-hashes) (`scrypt`) | MIT OR Apache-2.0 | scrypt key-derivation function |
| [sha2](https://github.com/RustCrypto/hashes) (`sha2`) | MIT OR Apache-2.0 | SHA-256 (chrome-bridge KDF) |
| [getrandom](https://github.com/rust-random/getrandom) (`getrandom`) | MIT OR Apache-2.0 | Cryptographic random bytes |
| [hex](https://github.com/KokaKiwi/rust-hex) (`hex`) | MIT OR Apache-2.0 | Hex encoding/decoding |
| [libc](https://github.com/rust-lang/libc) (`libc`) | MIT OR Apache-2.0 | Raw FFI bindings to platform C libraries |
| [tokio](https://github.com/tokio-rs/tokio) (`tokio`) | MIT | Async runtime (Skill Forge sandbox supervisor) |
| [tempfile](https://github.com/Stebalien/tempfile) (`tempfile`) | MIT OR Apache-2.0 | Temporary files |
| [uuid](https://github.com/uuid-rs/uuid) (`uuid`) | MIT OR Apache-2.0 | UUIDs |
| [lru](https://github.com/jeromefroe/lru-rs) (`lru`) | MIT | LRU cache (warm sandbox pool) |
| [which](https://github.com/harryfei/which-rs) (`which`) | MIT | Executable lookup |
| [dashmap](https://github.com/xacrimon/dashmap) (`dashmap`) | MIT | Concurrent map |
| [thiserror](https://github.com/dtolnay/thiserror) (`thiserror`) | MIT OR Apache-2.0 | Error derive |
| [nix](https://github.com/nix-rust/nix) (`nix`) | MIT | Unix syscalls (Linux sandbox) |
| [seccompiler](https://github.com/rust-vmm/seccompiler) (`seccompiler`) | Apache-2.0 OR BSD-3-Clause | seccomp filters (Linux sandbox) |
| [landlock](https://github.com/landlock-lsm/rust-landlock) (`landlock`) | MIT OR Apache-2.0 | Landlock filesystem sandbox (Linux) |
| [windows-sys](https://github.com/microsoft/windows-rs) (`windows-sys`) | MIT OR Apache-2.0 | Win32 bindings (Windows sandbox) |
| [webrtc-vad](https://github.com/kpcyrd/webrtc-vad-rs) (`webrtc-vad`) | MIT OR Apache-2.0 | libfvad-backed voice activity detection (gated behind cargo feature `vad`, used by `pcm_vad.rs`) |

## Design ideas we follow

Not dependencies: rules Bhai's own code implements, credited to where they come from.

| Project | Idea |
|---------|------|
| [MELRA](https://github.com/XAGI-Lab/melra) (XAGI Labs) | A change whose outcome is uncertain is checked, never blindly repeated. A tool that times out may still land its change, so Bhai tells the model to check before running it again, and never sends the same message twice while one is still in flight. |

---

*All trademarks and registered trademarks are the property of their respective owners.
The use of these open-source libraries does not imply any endorsement by their authors.*

**Bhai itself is proprietary software. See [LICENSE.md](./LICENSE.md).**
