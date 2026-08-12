#!/usr/bin/env python3
"""
Add the hall structure - walls, pillars, service counters - to a layout file.

The official map draws the building as solid black and grey shapes, mixed in
with the hairline table grid and the outlined lettering.  A morphological
opening separates them: erode by a few pixels and the hairlines and glyph
strokes vanish while the solid architecture survives, then dilate back to
restore its size.  What is left is decomposed into rectangles by merging
identical horizontal runs between neighbouring scanlines.

Only the band of the page that holds the halls is considered, so the cover
artwork and the event logo along the bottom are never picked up - the output is
the building, not the decoration.

    python3 tools/extract_structure.py maps/C108Map_all_B4.pdf data/C108.json
"""
from __future__ import annotations

import glob
import json
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

DPI = 200
PX = DPI / 72.0
PAPER = 236          # anything darker than this is ink of some kind
OPEN_K = 7           # erode/dilate window: kills hairlines, keeps solids
MIN_PT = 2.2         # ignore specks smaller than this in either direction

# The vertical slice of each page occupied by the halls, in PDF points, read off
# the printed map.  Everything below is the title banner and the cover artwork.
HALL_BAND = {
    1: (140, 640),
    2: (120, 640),
    3: (78, 660),
    4: (150, 640),
}


def render(pdf: str, page: int, tmpdir: str) -> np.ndarray:
    stem = f'{tmpdir}/s{page}'
    subprocess.run(['pdftoppm', '-gray', '-png', '-r', str(DPI),
                    '-f', str(page), '-l', str(page), pdf, stem], check=True)
    return np.array(Image.open(sorted(glob.glob(stem + '*.png'))[0]).convert('L'))


def solid_mask(img: np.ndarray) -> np.ndarray:
    ink = Image.fromarray(((img < PAPER) * 255).astype(np.uint8))
    opened = ink.filter(ImageFilter.MinFilter(OPEN_K)).filter(ImageFilter.MaxFilter(OPEN_K))
    return np.array(opened) > 127


def rectangles(mask: np.ndarray, min_px: int):
    """Merge identical horizontal runs across scanlines into rectangles."""
    rects: list[tuple[int, int, int, int]] = []
    pending: dict[tuple[int, int], list[int]] = {}
    for y in range(mask.shape[0]):
        row = mask[y]
        runs = set()
        if row.any():
            edges = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
            runs = {(int(a), int(b)) for a, b in zip(edges[0::2], edges[1::2])}
        for run in runs:
            if run in pending:
                pending[run][1] = y
            else:
                pending[run] = [y, y]
        for run in list(pending):
            if run not in runs:
                y0, y1 = pending.pop(run)
                if run[1] - run[0] >= min_px and y1 - y0 + 1 >= min_px:
                    rects.append((run[0], y0, run[1], y1 + 1))
    for run, (y0, y1) in pending.items():
        if run[1] - run[0] >= min_px and y1 - y0 + 1 >= min_px:
            rects.append((run[0], y0, run[1], y1 + 1))
    return rects


def shade(img: np.ndarray, rect) -> float:
    """Mean darkness of a rectangle, 0 = white, 1 = black."""
    x0, y0, x1, y1 = rect
    patch = img[y0:y1, x0:x1]
    return float(1.0 - patch.mean() / 255.0) if patch.size else 0.0


def extract(pdf: str, page_no: int, page_h: float):
    with tempfile.TemporaryDirectory() as tmp:
        img = render(pdf, page_no, tmp)

    band = HALL_BAND[page_no]
    top = int(round((page_h - band[1]) * PX))
    bottom = int(round((page_h - band[0]) * PX))
    view = img[max(0, top):bottom]

    mask = solid_mask(view)
    min_px = int(MIN_PT * PX)
    out = []
    for x0, y0, x1, y1 in rectangles(mask, min_px):
        rect = (x0, y0, x1, y1)
        tone = shade(view, rect)
        out.append({
            'x': round(x0 / PX, 1),
            'y': round(page_h - (y1 + top) / PX, 1),
            'w': round((x1 - x0) / PX, 1),
            'h': round((y1 - y0) / PX, 1),
            # keep the drawn tone so walls stay black and platforms stay grey
            'tone': round(min(1.0, max(0.0, tone)), 2),
        })
    return out


def main(pdf: str, layout_path: str) -> None:
    doc = json.load(open(layout_path, encoding='utf-8'))
    for page in doc['pages']:
        page_no = page['index'] + 1
        shapes = extract(pdf, page_no, page['height'])
        page['structures'] = shapes
        area = sum(s['w'] * s['h'] for s in shapes)
        print(f'page {page_no}: {len(shapes)} shapes, {area / 1000:.0f}k pt² of building')
    with open(layout_path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    print('updated', layout_path,
          f'({len(open(layout_path, "rb").read()) / 1024:.0f} kB)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
