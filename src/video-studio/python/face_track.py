#!/usr/bin/env python3
# Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.
"""
face_track.py — MediaPipe face detection sidecar for Bhai Video Studio.
Usage: python face_track.py <videoPath> <outputJsonPath>
Writes JSON: { videoPath, fps, width, height,
               frames: [{t, faces:[{x,y,w,h,score}]}] }
Samples every max(1, int(fps/10))-th frame to stay at ~10 Hz.
"""

import json
import pathlib
import sys


def detect_faces(video_path: str, output_path: str) -> None:
    import cv2
    import mediapipe as mp

    face_detection = mp.solutions.face_detection.FaceDetection(
        model_selection=1,
        min_detection_confidence=0.5,
    )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[face_track] Cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps: float = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width: int = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height: int = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    sample_every: int = max(1, int(fps / 10))

    frames = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_every == 0:
            t = round(frame_idx / fps, 4)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_detection.process(rgb)

            face_list = []
            if results.detections:
                for det in results.detections:
                    bb = det.location_data.relative_bounding_box
                    x = max(0, int(bb.xmin * width))
                    y = max(0, int(bb.ymin * height))
                    w = int(bb.width * width)
                    h = int(bb.height * height)
                    score = round(float(det.score[0]), 4) if det.score else 0.0
                    face_list.append({"x": x, "y": y, "w": w, "h": h, "score": score})

            frames.append({"t": t, "faces": face_list})

        frame_idx += 1

    cap.release()
    face_detection.close()

    output = {
        "videoPath": video_path,
        "fps": round(fps, 4),
        "width": width,
        "height": height,
        "frames": frames,
    }

    out_path = pathlib.Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[face_track] wrote {len(frames)} sampled frames to {output_path}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: face_track.py <videoPath> <outputJsonPath>", file=sys.stderr)
        sys.exit(1)
    try:
        detect_faces(sys.argv[1], sys.argv[2])
    except Exception as exc:
        print(f"[face_track] error: {exc}", file=sys.stderr)
        sys.exit(1)
