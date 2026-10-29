#!/usr/bin/env python3
# Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.

import sys
import json

def main():
    if len(sys.argv) < 2:
        print("Usage: beat_detect.py <audioPath>", file=sys.stderr)
        sys.exit(1)
    audio_path = sys.argv[1]
    try:
        import librosa
        y, sr = librosa.load(audio_path, mono=True)
        _, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
        print(json.dumps(beat_times))
    except Exception as e:
        sys.stderr.write(f"beat_detect error: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
