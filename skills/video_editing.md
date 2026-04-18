---
name: Video Editor
role: video_editor
description: Full video editing pipeline — create projects, analyze footage, plan edits, render output, and deliver reels, shorts, TikToks, and long-form videos.
triggers:
  - video
  - edit
  - cut
  - trim
  - join
  - reel
  - tiktok
  - short
  - caption
  - subtitle
  - transition
  - background removal
  - render
  - highlight reel
  - montage
  - overlay
  - music sync
  - beat sync
  - green screen
  - aspect ratio
  - vertical video
  - horizontal video
  - compress video
  - ffmpeg
---

## The Four-Step Pipeline

Every video editing task follows this exact sequence. Never skip steps.

### 1. Create project (`video_create_project`)
Pass input file paths. Copies into a durable project directory. Returns `projectId`.

### 2. Analyze footage (`video_analyze`)
Scene detection + frame captioning + word-level transcription. Results hash-cached.

### 3. Plan the edit (`video_plan_edit`)
Natural-language intent → validated `edit_plan.json`. Review before rendering.

### 4. Render (`video_render`)
Executes plan via FFmpeg. Captions and beat-sync auto-apply.

---

## When to patch vs re-plan

- **`video_patch_plan`** (JSON Patch): one field changes — aspect ratio, a single in/out, volume.
- **Re-run `video_plan_edit`**: user intent has changed substantially, or 3+ values need changing.

---

## Aspect ratio from user signals

| User says | Aspect |
|---|---|
| reel, short, TikTok, vertical, 9:16 | 9:16 (1080x1920) |
| YouTube, landscape, 16:9 | 16:9 (1920x1080) |
| square, Instagram post, 1:1 | 1:1 (1080x1080) |
| (no mention) | 16:9 default |

Always surface the assumed aspect to the user before rendering.

---

## Caption styles

- `reel_karaoke` — large bold centered, per-word color flip. Best for reels/TikToks.
- `minimal` — small white bottom, thin outline. Best for tutorials/professional.
- `bold` — Impact font, classic viral caption. Best for memes/punchlines.

---

## When `video_ffmpeg` is appropriate

Never first choice. Only for:
- Specific codec conversion the pipeline doesn't support.
- Extracting a single stream.
- Debugging a render failure.

Input paths must be inside `data/video-projects/` or `/tmp/`.

---

## Multi-video workflow

`video_create_project([a.mp4, b.mp4])` → `video_analyze` → `video_plan_edit("join with fade, add music")` → `video_render`.

---

## Music and beat sync

- Planner adds `audio` track in plan.
- `duck_on_speech: true` auto-lowers music during speech.
- `sync_to_beats: true` snaps cuts to beat grid via librosa.
- Source music via `searchMusic({mood, bpm})` or user file.

---

## Error recovery

- FFmpeg codec error → add `-c:v libx264 -c:a aac` intermediate, retry.
- Scene detection fails → auto fallback to 5s keyframe sampling.
- Beat-sync (librosa) unavailable → omit from plan, render without.
- Plan validation error → patch the specific invalid field, don't re-plan everything.
