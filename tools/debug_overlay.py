#!/usr/bin/env python3
"""Render a map page with the extracted space grid drawn on top.

Every cell is outlined and labelled with the space number the layout data
resolves it to, so the result can be compared straight against the printed
numbers underneath.

    python3 tools/debug_overlay.py data/C108.json maps/C108Map_all_B4.pdf 1 out.png
"""
import glob
import json
import math
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

DPI = 200
PX = DPI / 72.0


def load_font(size):
    for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def space_cell(block, number):
    """Return (x0, y0, x1, y1) in PDF points for a space number in a block."""
    count = block['count']
    half = count // 2
    rows = block['rows']
    if not 1 <= number <= count:
        return None
    if number <= half:
        row, side = number - 1, 'right'
    else:
        row, side = count - number, 'left'
    if block.get('mirror'):
        side = 'left' if side == 'right' else 'right'
    y0, y1 = rows[row]
    x, w = block['x'], block['w']
    x0 = x + w / 2 if side == 'right' else x
    return x0, y0, x0 + w / 2, y1


def wall_cells(strip):
    """Yield (number, corners) for every space in a printed wall strip."""
    count = abs(strip['to'] - strip['from']) + 1
    step = 1 if strip['to'] >= strip['from'] else -1
    angle = math.radians(strip.get('a', 0 if strip.get('axis') == 'x' else 90))
    ux, uy = math.cos(angle), math.sin(angle)
    length = strip['w'] if strip.get('axis') == 'x' or 'a' in strip else strip['h']
    depth = strip['h'] if strip.get('axis') == 'x' or 'a' in strip else strip['w']
    # a plain rectangle is anchored bottom-left, a turned one at its first cell
    ox = strip['x'] + (strip['w'] if strip.get('axis') == 'y' else 0)
    oy = strip['y']

    for i in range(count):
        s0, s1 = length * i / count, length * (i + 1) / count
        corners = [(ox + s * ux - t * uy, oy + s * uy + t * ux)
                   for s, t in ((s0, 0), (s1, 0), (s1, depth), (s0, depth))]
        yield strip['from'] + step * i, corners


def main(layout_path, pdf, page_no, out_png):
    doc = json.load(open(layout_path, encoding='utf-8'))
    page = doc['pages'][page_no - 1]
    with tempfile.TemporaryDirectory() as tmp:
        stem = f'{tmp}/p'
        subprocess.run(['pdftoppm', '-png', '-r', str(DPI), '-f', str(page_no),
                        '-l', str(page_no), pdf, stem], check=True)
        img = Image.open(sorted(glob.glob(stem + '*.png'))[0]).convert('RGB')

    draw = ImageDraw.Draw(img, 'RGBA')
    font = load_font(11)
    big = load_font(26)
    H = page['height']

    for block in page['blocks']:
        for n in range(1, block['count'] + 1):
            cell = space_cell(block, n)
            if not cell:
                continue
            x0, y0, x1, y1 = cell
            box = [x0 * PX, (H - y1) * PX, x1 * PX, (H - y0) * PX]
            draw.rectangle(box, outline=(255, 0, 0, 200), width=1)
            draw.text((box[0] + 2, box[1] + 1), str(n),
                      font=font, fill=(0, 120, 255, 255))
        x = block['x'] * PX
        top = (H - block['rows'][-1][1]) * PX
        draw.text((x, top - 30), f"{block['block']}({block['count']})",
                  font=big, fill=(200, 0, 160, 255))

    for strip in page.get('wallStrips', []):
        for number, corners in wall_cells(strip):
            points = [(x * PX, (H - y) * PX) for x, y in corners]
            draw.polygon(points, outline=(0, 160, 0, 220))
            draw.text((min(p[0] for p in points) + 1,
                       min(p[1] for p in points) + 1), str(number),
                      font=font, fill=(220, 0, 0, 255))

    img.save(out_png)
    print('wrote', out_png, img.size)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4])
