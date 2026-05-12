#!/usr/bin/env python3
# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
#
# OmniParser-v2 style element detector. Uses YOLOv8 (small detector, ~6MB) to find
# interactive UI elements in a screenshot. Optionally adds Florence-2 captions
# when --captions is passed AND the model is locally cached (Florence-2-base is ~770MB).
#
# Usage:
#   python3 omniparser_detect.py <screenshot.png> [--captions] [--max-elements N]
#
# Output (stdout): JSON
#   {
#     "elements": [
#       { "id": 1, "bbox": [x1,y1,x2,y2], "score": 0.93, "caption": "...", "role": "interactive" },
#       ...
#     ],
#     "image_size": [w, h],
#     "model": "yolov8n" | "yolov8n+florence2",
#     "elapsed_ms": N
#   }
#
# On any missing dep: prints `error|<reason>` and exits 1.
#   Reasons: yolo_not_installed, model_not_cached, image_load_failed,
#            florence_not_installed (only with --captions).
#
# NOTE: This is a STUB scaffold for Phase 3. The actual OmniParser-v2 pipeline
# (microsoft/OmniParser on GitHub) is a heavier integration. This file lets the
# capability detector + cascade router treat OmniParser as a present-but-optional
# component without ATLAS bundling the model.
import argparse
import json
import sys
import time


def fail(reason: str) -> None:
    sys.stdout.write(f"error|{reason}\n")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--captions", action="store_true")
    parser.add_argument("--max-elements", type=int, default=50)
    parser.add_argument("--conf-threshold", type=float, default=0.25)
    args = parser.parse_args()

    start = time.monotonic()

    try:
        from PIL import Image  # type: ignore
    except Exception:
        fail("pillow_not_installed")
        return

    try:
        img = Image.open(args.image).convert("RGB")
        w, h = img.size
    except Exception as e:
        fail(f"image_load_failed:{e}")
        return

    try:
        from ultralytics import YOLO  # type: ignore
    except Exception:
        fail("yolo_not_installed")
        return

    # Look for OmniParser's YOLOv8 weights. The official path is `microsoft/OmniParser/weights/icon_detect/best.pt`.
    # Users install via:
    #   pip install ultralytics
    #   huggingface-cli download microsoft/OmniParser-v2.0 icon_detect/model.pt --local-dir <cache>
    # For this scaffold we accept any locally-cached path or fall back to YOLOv8n general detector.
    import os

    model_paths = [
        os.environ.get("OMNIPARSER_MODEL_PATH"),
        os.path.expanduser("~/.cache/omniparser/icon_detect.pt"),
        os.path.expanduser("~/.cache/omniparser/model.pt"),
        "weights/icon_detect/best.pt",
    ]
    model_path = next((p for p in model_paths if p and os.path.exists(p)), None)
    if not model_path:
        # Fall back to the general YOLOv8n (Ultralytics auto-downloads on first use).
        # This won't be UI-specific but provides a usable signal.
        try:
            model = YOLO("yolov8n.pt")
            model_name = "yolov8n-general"
        except Exception as e:
            fail(f"model_not_cached:{e}")
            return
    else:
        try:
            model = YOLO(model_path)
            model_name = "omniparser-yolov8"
        except Exception as e:
            fail(f"model_load_failed:{e}")
            return

    try:
        results = model.predict(args.image, conf=args.conf_threshold, verbose=False)
    except Exception as e:
        fail(f"detection_failed:{e}")
        return

    elements = []
    next_id = 1
    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for i in range(len(boxes)):
            xyxy = boxes.xyxy[i].tolist()
            conf = float(boxes.conf[i].item())
            cls = int(boxes.cls[i].item()) if boxes.cls is not None else -1
            elements.append({
                "id": next_id,
                "bbox": [int(xyxy[0]), int(xyxy[1]), int(xyxy[2]), int(xyxy[3])],
                "score": round(conf, 3),
                "class_id": cls,
                "caption": "",
                "role": "interactive",
            })
            next_id += 1
            if len(elements) >= args.max_elements:
                break
        if len(elements) >= args.max_elements:
            break

    # Optional Florence-2 captioning (heavy: only attempt when --captions and model cached)
    if args.captions and elements:
        try:
            from transformers import AutoProcessor, AutoModelForCausalLM  # type: ignore

            # Try cached model first; do NOT auto-download (770MB)
            florence_path = os.environ.get("FLORENCE2_MODEL_PATH") or os.path.expanduser("~/.cache/florence2")
            if os.path.exists(florence_path):
                processor = AutoProcessor.from_pretrained(florence_path, trust_remote_code=True)
                florence_model = AutoModelForCausalLM.from_pretrained(florence_path, trust_remote_code=True)
                for el in elements:
                    x1, y1, x2, y2 = el["bbox"]
                    crop = img.crop((x1, y1, x2, y2))
                    inputs = processor(text="<OD>", images=crop, return_tensors="pt")
                    out = florence_model.generate(**inputs, max_new_tokens=20)
                    el["caption"] = processor.batch_decode(out, skip_special_tokens=True)[0][:60]
                model_name += "+florence2"
            else:
                # Caption skipped: not cached
                pass
        except Exception:
            # Caption failure is non-fatal; continue with bbox-only output
            pass

    elapsed_ms = int((time.monotonic() - start) * 1000)
    out = {
        "elements": elements,
        "image_size": [w, h],
        "model": model_name,
        "elapsed_ms": elapsed_ms,
    }
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
