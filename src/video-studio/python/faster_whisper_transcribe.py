#!/usr/bin/env python3
"""
faster_whisper_transcribe.py — Word-level transcript via faster-whisper.
Usage: python faster_whisper_transcribe.py <audioPath> <outputJsonPath> [modelSize]
"""

import sys
import json
import pathlib


def transcribe(audio_path: str, output_path: str, model_size: str = "base") -> None:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
    )

    language = info.language
    segments = []

    for seg in segments_iter:
        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "start": round(w.start, 4),
                    "end": round(w.end, 4),
                    "word": w.word,
                    "confidence": round(w.probability, 4),
                })
        segments.append({
            "start": round(seg.start, 4),
            "end": round(seg.end, 4),
            "text": seg.text.strip(),
            "words": words,
        })

    result = {"language": language, "segments": segments}
    pathlib.Path(output_path).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[faster-whisper] {len(segments)} segments, language={language}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: faster_whisper_transcribe.py <audioPath> <outputJsonPath> [modelSize]", file=sys.stderr)
        sys.exit(1)
    model_size = sys.argv[3] if len(sys.argv) >= 4 else "base"
    transcribe(sys.argv[1], sys.argv[2], model_size)
