#!/usr/bin/env python3
# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.
#
# bg_matte.py — BiRefNet alpha-matte generator for ATLAS Video Studio.
# Usage: python bg_matte.py <video_path> <model_dir> <output_matte_path>
#
# Writes a ProRes 4444 .mov (alpha channel preserved) to <output_matte_path>.
# Logs progress every 30 frames to stderr: [bg_matte] frame 30/300 (10%) gpu=cuda

import os
import subprocess
import sys
import shutil


def main() -> None:
    if len(sys.argv) != 4:
        print("Usage: bg_matte.py <video_path> <model_dir> <output_matte_path>", file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    model_dir = sys.argv[2]
    output_matte_path = sys.argv[3]

    try:
        import cv2
        import numpy as np
        import torch
        from transformers import AutoModelForImageSegmentation
    except ImportError as e:
        print(f"[bg_matte] Import error — missing dependency: {e}", file=sys.stderr)
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[bg_matte] Loading BiRefNet from {model_dir} on {device}", file=sys.stderr)

    try:
        model = AutoModelForImageSegmentation.from_pretrained(
            model_dir,
            trust_remote_code=True,
        )
        model.to(device)
        model.eval()
    except Exception as e:
        print(f"[bg_matte] Failed to load model: {e}", file=sys.stderr)
        sys.exit(1)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[bg_matte] Cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    frames_dir = output_matte_path + "_frames"
    os.makedirs(frames_dir, exist_ok=True)

    BIREFNET_SIZE = 1024
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    frame_idx = 0
    try:
        while True:
            ret, bgr = cap.read()
            if not ret:
                break

            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            resized = cv2.resize(rgb, (BIREFNET_SIZE, BIREFNET_SIZE))
            tensor = (resized.astype(np.float32) / 255.0 - mean) / std
            tensor = torch.from_numpy(tensor).permute(2, 0, 1).unsqueeze(0).to(device)

            with torch.no_grad():
                output = model(tensor)
                if isinstance(output, (list, tuple)):
                    pred = output[-1]
                else:
                    pred = output
                if hasattr(pred, "logits"):
                    pred = pred.logits
                alpha = torch.sigmoid(pred).squeeze().cpu().numpy()

            alpha_resized = cv2.resize(alpha.astype(np.float32), (orig_w, orig_h))
            alpha_uint8 = (alpha_resized * 255).clip(0, 255).astype(np.uint8)

            frame_path = os.path.join(frames_dir, f"frame_{frame_idx:06d}.png")
            cv2.imwrite(frame_path, alpha_uint8)

            frame_idx += 1
            if frame_idx % 30 == 0:
                pct = int(frame_idx / max(total_frames, 1) * 100)
                print(
                    f"[bg_matte] frame {frame_idx}/{total_frames} ({pct}%) gpu={device}",
                    file=sys.stderr,
                    flush=True,
                )
    except Exception as e:
        cap.release()
        print(f"[bg_matte] Inference error at frame {frame_idx}: {e}", file=sys.stderr)
        sys.exit(1)

    cap.release()
    print(f"[bg_matte] Inference complete — {frame_idx} frames. Stitching to ProRes 4444...", file=sys.stderr)

    frame_pattern = os.path.join(frames_dir, "frame_%06d.png")
    ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg_bin,
        "-framerate", str(fps),
        "-i", frame_pattern,
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        "-y",
        output_matte_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[bg_matte] ffmpeg stitch failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)

    shutil.rmtree(frames_dir, ignore_errors=True)
    print(f"[bg_matte] Done — matte written to {output_matte_path}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[bg_matte] Fatal: {exc}", file=sys.stderr)
        sys.exit(1)
