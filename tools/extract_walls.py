#!/usr/bin/env python3
"""
Reduce the printed hall walls to line segments, so the gaps show the doorways.

The official map draws the building as solid black and grey shapes.  A
morphological opening separates them from the hairline table grid and the
outlined lettering: erode a few pixels and the thin work disappears while the
architecture survives.  Each hall edge is then a band of that mask projected
onto one axis, which gives the stretches where there is wall and, between them,
the stretches where there is not - the openings you walk through.

Storing intervals rather than shapes keeps this to a few hundred numbers and
means the map can stay a line drawing.

    python3 tools/extract_walls.py maps/C108Map_all_B4.pdf data/C108.json
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
PAPER = 236           # darker than this counts as building
OPEN_K = 7            # erode/dilate window
REACH = 26            # how far either side of an edge to look for its wall
MIN_RUN = 3.0         # ignore wall slivers shorter than this, in points
MIN_GAP = 4.0         # and treat hairline breaks as continuous wall
PAD = 30              # must match PAD in src/mapdraw.js


def render(pdf: str, page: int, tmpdir: str) -> np.ndarray:
    stem = f'{tmpdir}/w{page}'
    subprocess.run(['pdftoppm', '-gray', '-png', '-r', str(DPI),
                    '-f', str(page), '-l', str(page), pdf, stem], check=True)
    return np.array(Image.open(sorted(glob.glob(stem + '*.png'))[0]).convert('L'))


def solid(img: np.ndarray) -> np.ndarray:
    ink = Image.fromarray(((img < PAPER) * 255).astype(np.uint8))
    opened = ink.filter(ImageFilter.MinFilter(OPEN_K)).filter(ImageFilter.MaxFilter(OPEN_K))
    return np.array(opened) > 127


def runs(flags, min_run, min_gap):
    """Contiguous True stretches, merging gaps shorter than min_gap."""
    spans = []
    start = None
    for i, on in enumerate(flags):
        if on and start is None:
            start = i
        elif not on and start is not None:
            spans.append([start, i])
            start = None
    if start is not None:
        spans.append([start, len(flags)])

    merged = []
    for span in spans:
        if merged and span[0] - merged[-1][1] < min_gap:
            merged[-1][1] = span[1]
        else:
            merged.append(span)
    return [s for s in merged if s[1] - s[0] >= min_run]


def hall_box(page, hall):
    blocks = [b for b in page['blocks'] if b['hall'] == hall]
    if not blocks:
        return None
    x0 = min(b['x'] for b in blocks)
    x1 = max(b['x'] + b['w'] for b in blocks)
    ys = [y for b in blocks for r in b['rows'] for y in r]
    return (x0 - PAD, min(ys) - PAD, x1 + PAD, max(ys) + PAD)


def edges_for(mask, page_h, box):
    """Wall segments along each side of a hall box, in PDF points."""
    x0, y0, x1, y1 = box
    out = []

    def px(v):
        return int(round(v * PX))

    def py(v):
        return int(round((page_h - v) * PX))

    for side in ('left', 'right', 'top', 'bottom'):
        if side in ('left', 'right'):
            at = x0 if side == 'left' else x1
            band = mask[py(y1):py(y0), max(0, px(at - REACH)):px(at + REACH)]
            if band.size == 0:
                continue
            flags = band.any(axis=1)                    # top-down
            for a, b in runs(flags, MIN_RUN * PX, MIN_GAP * PX):
                out.append({'side': side,
                            'from': round(y1 - b / PX, 1),
                            'to': round(y1 - a / PX, 1)})
        else:
            at = y1 if side == 'top' else y0
            band = mask[max(0, py(at + REACH)):py(at - REACH), px(x0):px(x1)]
            if band.size == 0:
                continue
            flags = band.any(axis=0)                    # left-right
            for a, b in runs(flags, MIN_RUN * PX, MIN_GAP * PX):
                out.append({'side': side,
                            'from': round(x0 + a / PX, 1),
                            'to': round(x0 + b / PX, 1)})
    return out


def main(pdf: str, layout_path: str) -> None:
    doc = json.load(open(layout_path, encoding='utf-8'))
    with tempfile.TemporaryDirectory() as tmp:
        for page in doc['pages']:
            page_no = page['index'] + 1
            mask = solid(render(pdf, page_no, tmp))
            walls = {}
            for hall in page['halls']:
                box = hall_box(page, hall)
                if box:
                    walls[hall] = edges_for(mask, page['height'], box)
            page['wallLines'] = walls
            total = sum(len(v) for v in walls.values())
            print(f'page {page_no}: {total} wall segments across {len(walls)} halls')
    with open(layout_path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    print('updated', layout_path,
          f'({len(open(layout_path, "rb").read()) // 1024} kB)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
