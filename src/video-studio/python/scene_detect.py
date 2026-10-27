#!/usr/bin/env python3
"""
scene_detect.py — PySceneDetect sidecar for Bhai Video Studio.
Usage: python scene_detect.py <videoPath> <outputJsonPath>
Writes: {"scenes": [{"start": float, "end": float, "duration": float}]}
"""

import sys
import json
import pathlib

def detect_scenes(video_path: str, output_path: str) -> None:
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector

    video = open_video(video_path)
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector(threshold=27.0))
    scene_manager.detect_scenes(video, show_progress=False)
    scene_list = scene_manager.get_scene_list()

    scenes = []
    for start_tc, end_tc in scene_list:
        start = start_tc.get_seconds()
        end = end_tc.get_seconds()
        scenes.append({
            "start": round(start, 4),
            "end": round(end, 4),
            "duration": round(end - start, 4),
        })

    output = {"scenes": scenes}
    pathlib.Path(output_path).write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"[scene_detect] wrote {len(scenes)} scenes to {output_path}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: scene_detect.py <videoPath> <outputJsonPath>", file=sys.stderr)
        sys.exit(1)
    detect_scenes(sys.argv[1], sys.argv[2])
