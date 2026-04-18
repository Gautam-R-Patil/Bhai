#!/usr/bin/env python3
"""Add coordinate grid overlay to a screenshot for LLM coordinate accuracy.
Usage: python3 grid_overlay.py input.png output.jpg [grid_size]
Draws light grid lines and coordinate labels so the LLM can accurately pick x,y positions.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

def add_grid(input_path, output_path, grid_size=100):
    img = Image.open(input_path).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    
    # Use a small built-in font
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
    except:
        font = ImageFont.load_default()

    # Draw vertical lines with x-coordinate labels
    for x in range(0, w, grid_size):
        # Semi-transparent line
        draw.line([(x, 0), (x, h)], fill=(255, 0, 0, 40), width=1)
        # Coordinate label at top
        if x > 0:
            label = str(x)
            draw.rectangle([(x-1, 0), (x + len(label)*7 + 3, 13)], fill=(0, 0, 0, 160))
            draw.text((x + 2, 0), label, fill=(255, 255, 255, 220), font=font)

    # Draw horizontal lines with y-coordinate labels
    for y in range(0, h, grid_size):
        draw.line([(0, y), (w, y)], fill=(255, 0, 0, 40), width=1)
        if y > 0:
            label = str(y)
            draw.rectangle([(0, y-1), (len(label)*7 + 3, y + 13)], fill=(0, 0, 0, 160))
            draw.text((2, y), label, fill=(255, 255, 255, 220), font=font)

    # Save as JPEG
    img.save(output_path, "JPEG", quality=85)
    print(f"{w}x{h}")

if __name__ == "__main__":
    inp = sys.argv[1]
    out = sys.argv[2]
    grid = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    add_grid(inp, out, grid)
