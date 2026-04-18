#!/usr/bin/env python3
"""Overlay numbered element badges on a screenshot (Set-of-Mark prompting).
Usage: python3 som_overlay.py <input_image> <elements_json> <output_image>
Reads a JSON array of detected elements and draws numbered badges at each position.
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

BADGE_RADIUS = 12
BADGE_BG = (255, 102, 0, 200)        # #FF6600, slightly transparent
OUTLINE_COLOR = (255, 102, 0, 80)    # subtle semi-transparent orange
OVERLAP_THRESHOLD = 20
FONT_SIZE = 11


def load_font():
    for path in [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
    ]:
        try:
            return ImageFont.truetype(path, FONT_SIZE)
        except Exception:
            continue
    return ImageFont.load_default()


def resolve_positions(elements):
    """Adjust badge positions so overlapping badges are offset upward."""
    positions = []
    for el in elements:
        bx, by = int(el["x"]), int(el["y"])
        for px, py in positions:
            if abs(bx - px) < OVERLAP_THRESHOLD and abs(by - py) < OVERLAP_THRESHOLD:
                by -= OVERLAP_THRESHOLD
                break
        positions.append((bx, by))
    return positions


def add_som(input_path, elements_path, output_path):
    img = Image.open(input_path).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    font = load_font()

    with open(elements_path) as f:
        elements = json.load(f)

    positions = resolve_positions(elements)

    for el, (bx, by) in zip(elements, positions):
        # Draw bounding-box outline if dimensions are provided
        w = el.get("w", 0)
        h = el.get("h", 0)
        if w > 0 and h > 0:
            x0 = int(el["x"]) - w // 2
            y0 = int(el["y"]) - h // 2
            draw.rectangle([x0, y0, x0 + w, y0 + h], outline=OUTLINE_COLOR, width=1)

        # Draw badge circle
        draw.ellipse(
            [bx - BADGE_RADIUS, by - BADGE_RADIUS,
             bx + BADGE_RADIUS, by + BADGE_RADIUS],
            fill=BADGE_BG,
        )

        # Draw label number centered in the badge
        label = str(el["label"])
        bbox = font.getbbox(label)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(
            (bx - tw / 2, by - th / 2 - 1),
            label,
            fill=(255, 255, 255, 255),
            font=font,
        )

    img.save(output_path, "JPEG", quality=85)
    print(f"{img.size[0]}x{img.size[1]} — {len(elements)} elements labeled")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python3 som_overlay.py <input_image> <elements_json> <output_image>")
        sys.exit(1)
    add_som(sys.argv[1], sys.argv[2], sys.argv[3])
