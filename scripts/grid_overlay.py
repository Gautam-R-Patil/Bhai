#!/usr/bin/env python3
"""Add a coordinate grid overlay to a screenshot for LLM coordinate accuracy.

Usage:
    python3 grid_overlay.py INPUT.png OUTPUT.jpg [GRID_PX] [SCREEN_WIDTH]

If SCREEN_WIDTH is provided AND differs from the image width, grid labels show
SCREEN-space coordinates instead of image-pixel coordinates. The LLM can then
read the labels and emit clicks that the runtime passes through 1:1 (no mental
or code-side scaling needed). When SCREEN_WIDTH is omitted (or matches the
image width) the labels are image-pixel coordinates — the legacy behavior.
"""
import sys
from PIL import Image, ImageDraw, ImageFont


def add_grid(input_path: str, output_path: str, grid_px: int = 100, screen_width: int | None = None) -> None:
    img = Image.open(input_path).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    w, h = img.size

    # Compute scale: image-pixel -> screen-point. Defaults to 1.0 (labels are image pixels).
    scale = (screen_width / w) if (screen_width and screen_width > 0 and w > 0) else 1.0

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
    except Exception:
        font = ImageFont.load_default()

    # Vertical lines + x-axis labels
    for x in range(0, w, grid_px):
        draw.line([(x, 0), (x, h)], fill=(255, 0, 0, 40), width=1)
        if x > 0:
            label = str(int(round(x * scale)))
            draw.rectangle([(x - 1, 0), (x + len(label) * 7 + 3, 13)], fill=(0, 0, 0, 160))
            draw.text((x + 2, 0), label, fill=(255, 255, 255, 220), font=font)

    # Horizontal lines + y-axis labels
    for y in range(0, h, grid_px):
        draw.line([(0, y), (w, y)], fill=(255, 0, 0, 40), width=1)
        if y > 0:
            label = str(int(round(y * scale)))
            draw.rectangle([(0, y - 1), (len(label) * 7 + 3, y + 13)], fill=(0, 0, 0, 160))
            draw.text((2, y), label, fill=(255, 255, 255, 220), font=font)

    img.save(output_path, "JPEG", quality=85)
    print(f"{w}x{h} scale={scale:.3f}")


if __name__ == "__main__":
    inp = sys.argv[1]
    out = sys.argv[2]
    grid = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    screen_w = int(sys.argv[4]) if len(sys.argv) > 4 else None
    add_grid(inp, out, grid, screen_w)
