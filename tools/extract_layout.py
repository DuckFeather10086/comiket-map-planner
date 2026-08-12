#!/usr/bin/env python3
"""
Extract the island/space grid of a Comiket hall map PDF into JSON.

The official map is print-ready vector art with every glyph converted to
outlines, so there is no text to read.  What *is* reliable is the geometry:
each block (ア, ヨ, B, む, k ...) is drawn as one narrow two-column "island"
strip, cut into boxed sections by the walking aisles, and every section is a
frame with evenly spaced horizontal separators - one per table row.

This script rasterises each page, recovers those strips and their row grids and
writes the coordinates of every individual space in PDF user space (origin at
the bottom-left of the page, y growing upwards), so the web app can place a pin
from a space code such as ``東ヨ-12a`` with no manual calibration.

Numbering model, verified cell by cell against the printed map:

    A block with N spaces has N/2 rows.  The right-hand column carries 1..N/2
    counting from the bottom row upwards, the left-hand column carries
    N/2+1..N counting from the top row downwards, so the two cells on one row
    always add up to N+1.  Halls drawn mirrored set "mirror", swapping the
    columns.

Usage:
    python3 tools/extract_layout.py maps/C108Map_all_B4.pdf data/C108.json
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import statistics
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

DPI = 200
PX = DPI / 72.0          # pixels per PDF point
DARK = 150               # grayscale threshold for "ink"


# --------------------------------------------------------------------------- #
# raster helpers
# --------------------------------------------------------------------------- #
def render_page(pdf: str, page: int, tmpdir: str) -> np.ndarray:
    stem = os.path.join(tmpdir, f'page{page}')
    subprocess.run(['pdftoppm', '-gray', '-png', '-r', str(DPI),
                    '-f', str(page), '-l', str(page), pdf, stem], check=True)
    return np.array(Image.open(sorted(glob.glob(stem + '*.png'))[0]).convert('L'))


def page_size(pdf: str, page: int) -> tuple[float, float]:
    out = subprocess.run(['pdfinfo', '-f', str(page), '-l', str(page), pdf],
                         capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith('Page') and 'size' in line:
            parts = line.split()
            return float(parts[-4]), float(parts[-2])
    raise RuntimeError('could not read page size')


def cluster(values, tol):
    """Group scalars into runs whose neighbours differ by at most tol."""
    values = sorted(values)
    groups, cur = [], [values[0]]
    for v in values[1:]:
        if v - cur[-1] <= tol:
            cur.append(v)
        else:
            groups.append(cur)
            cur = [v]
    groups.append(cur)
    return groups


def horizontal_runs(dark: np.ndarray):
    """Yield (y, x0, length) for every maximal horizontal run of ink."""
    for y in range(dark.shape[0]):
        row = dark[y]
        if not row.any():
            continue
        edges = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        for a, b in zip(edges[0::2], edges[1::2]):
            yield y, int(a), int(b - a)


def island_width(runs) -> int:
    """The most common full-island run length on the page."""
    tally: dict[int, int] = {}
    for _, _, length in runs:
        if 25 <= length <= 140:
            tally[length] = tally.get(length, 0) + 1
    return max(tally, key=tally.get)


# --------------------------------------------------------------------------- #
# grid recovery
# --------------------------------------------------------------------------- #
@dataclass
class Column:
    """One island strip inside one band: an x range plus its separator lines."""
    left: int
    right: int
    lines: list[int]
    boxes: list[tuple[int, int]] = field(default_factory=list)

    @property
    def width(self) -> int:
        return self.right - self.left


@dataclass
class Section:
    """One boxed run of table rows inside an island strip."""
    left: int
    right: int
    top: int
    bottom: int
    rows: list[tuple[int, int]] = field(default_factory=list)


def columns_in_band(dark, runs, width, y_lo, y_hi) -> list[Column]:
    """Recover the island strips whose rows lie inside one horizontal band.

    Bands are handled separately on purpose.  Where two halls sit above each
    other on the same page their strips share an x position but are drawn a
    couple of pixels apart, so a page-wide x cluster would average their frames
    into a position that matches neither.
    """
    tol = max(3, int(0.10 * width))
    keep = [(y, x0, x0 + length) for y, x0, length in runs
            if y_lo <= y <= y_hi and abs(length - width) <= tol]
    if not keep:
        return []

    xmap: dict[int, int] = {}
    for group in cluster({x0 for _, x0, _ in keep}, 6):
        centre = int(statistics.median(group))
        xmap.update({x: centre for x in group})

    grouped: dict[int, list[tuple[int, int, int]]] = {}
    for item in keep:
        grouped.setdefault(xmap[item[1]], []).append(item)

    columns = []
    for centre in sorted(grouped):
        items = grouped[centre]
        if len(items) < 12:                   # stray boxes, legends, wall stubs
            continue
        col = Column(left=int(statistics.median([i[1] for i in items])),
                     right=int(statistics.median([i[2] for i in items])),
                     lines=[int(statistics.median(g))
                            for g in cluster([i[0] for i in items], 4)])
        if len(col.lines) < 4 or col.width < width * 0.7:
            continue
        col.boxes = frame_boxes(dark, col, y_lo, y_hi)
        if col.boxes:
            columns.append(col)
    return columns


def frame_boxes(dark, col: Column, y_lo, y_hi) -> list[tuple[int, int]]:
    """Scanline ranges inside the band where both frame lines carry ink.

    The frames run the full height of a section and stop in the aisles between
    sections, which is what keeps the block letter printed in the aisle from
    welding two sections into one.
    """
    lo, hi = int(y_lo), int(y_hi) + 1
    left = dark[lo:hi, max(0, col.left - 2):col.left + 3].any(axis=1)
    right = dark[lo:hi, col.right - 2:col.right + 3].any(axis=1)
    framed = left & right

    boxes, y, height = [], 0, framed.shape[0]
    while y < height:
        if not framed[y]:
            y += 1
            continue
        start = y
        while y < height and framed[y]:
            y += 1
        boxes.append((start + lo, y - 1 + lo))
    return boxes


def row_pitch(columns: list[Column]) -> float:
    """Table row height for a band, from separator spacings inside boxes."""
    diffs: list[int] = []
    for col in columns:
        for top, bottom in col.boxes:
            inside = [ln for ln in col.lines if top + 3 < ln < bottom - 3]
            diffs.extend(int(d) for d in np.diff([top] + inside + [bottom]))
    if not diffs:
        return 0.0
    rough = statistics.median(diffs)
    tight = [d for d in diffs if 0.6 * rough <= d <= 1.5 * rough]
    return statistics.median(tight) if tight else rough


def rows_in_box(col: Column, top: int, bottom: int, pitch: float) -> Section | None:
    """Lay the table rows out evenly inside one boxed section.

    Taking the detected separators directly would lose a row here and there
    where a hand-lettered digit touches a frame, but the printed tables are
    perfectly regular, so box height plus row pitch rebuilds the grid exactly.
    """
    height = bottom - top
    if pitch <= 0 or height < pitch * 1.5:
        return None
    n = round(height / pitch)
    if n < 2 or abs(height / pitch - n) > 0.45:
        return None
    inside = [ln for ln in col.lines if top + 3 < ln < bottom - 3]
    if len(inside) < max(1, (n - 1) // 2):    # a plain filled box is not a table
        return None
    edges = [top + height * i / n for i in range(n + 1)]
    return Section(left=col.left, right=col.right, top=top, bottom=bottom,
                   rows=[(int(round(a)), int(round(b)))
                         for a, b in zip(edges, edges[1:])])


def blocks_in_band(dark, runs, width, band, px_h) -> list[dict]:
    """Recover one band's island strips and pair them with its block letters."""
    y_lo, y_hi = band['y'][0] * px_h, band['y'][1] * px_h
    columns = columns_in_band(dark, runs, width, y_lo, y_hi)
    pitch = row_pitch(columns)

    found = []
    for col in columns:
        sections = [s for s in (rows_in_box(col, t, b, pitch) for t, b in col.boxes)
                    if s is not None]
        # a real block is a table of at least a few rows; anything shorter is a
        # legend box or a fragment of the venue key that happens to line up
        if sum(len(s.rows) for s in sections) >= 4:
            found.append((col, sections))

    letters = [(hall, ch) for hall, chars in band['groups'] for ch in chars]
    if len(found) != len(letters):
        print(f'  !! band {band["groups"][0][0]} {band["y"]}: {len(found)} strips '
              f'vs {len(letters)} letters; x={[c.left for c, _ in found]}',
              file=sys.stderr)

    out = []
    for (col, sections), (hall, letter) in zip(found, letters):
        out.append({'sections': sections, 'block': letter, 'hall': hall,
                    'mirror': band.get('mirror', False)})
    return out


def to_json_block(entry: dict, page_h_pt: float) -> dict:
    sections: list[Section] = sorted(entry['sections'], key=lambda s: s.top)
    rows = sorted(r for sec in sections for r in sec.rows)
    # stored bottom-up so that index 0 is the row holding space 1
    ordered = [[round(page_h_pt - bottom / PX, 2),      # y0, lower edge
                round(page_h_pt - top / PX, 2)]         # y1, upper edge
               for top, bottom in reversed(rows)]
    return {
        'block': entry['block'],
        'hall': entry['hall'],
        'count': len(rows) * 2,
        'x': round(sections[0].left / PX, 2),
        'w': round((sections[0].right - sections[0].left) / PX, 2),
        'mirror': bool(entry['mirror']),
        'rows': ordered,
    }


# --------------------------------------------------------------------------- #
# per-page metadata, read off the printed map
# --------------------------------------------------------------------------- #
# Wall blocks (壁サークル) run along the hall walls as rotated strips that wrap
# around corners, so they have no regular island grid to recover.  They are
# listed here by name only: the app recognises the code, says so, and asks for
# the position to be pointed at on the map instead of guessing.
PAGES = [
    {   # East 1/2/3 - katakana blocks, a single full-height band
        'page': 1,
        'halls': ['東3', '東2', '東1'],
        'walls': [{'block': 'ア', 'hall': '東 壁'}],
        'bands': [{'y': (0.15, 0.70), 'groups': [
            ('東3', 'ヨユヤモメムミマホヘフヒハノネヌニ'),
            ('東2', 'ナトテツチタソセスシサコケ'),
            ('東1', 'クキカオエウイ')]}],
    },
    {   # East 7 - latin capitals, two bands
        'page': 2,
        'halls': ['東7'],
        'walls': [{'block': 'A', 'hall': '東7 壁'}],
        'bands': [
            {'y': (0.12, 0.50), 'groups': [('東7', 'MLKJIHGFEDCB')]},
            {'y': (0.50, 0.86), 'groups': [('東7', 'WVUTSRQPON')]},
        ],
    },
    {   # West 1/2 - hiragana blocks, two bands
        'page': 3,
        'halls': ['西1', '西2'],
        'walls': [{'block': 'め', 'hall': '西1 壁'}, {'block': 'あ', 'hall': '西2 壁'}],
        'bands': [
            {'y': (0.10, 0.49), 'groups': [('西1', 'ふひはのねぬになとてつ'),
                                           ('西2', 'ちたそせすしさこけくき')]},
            {'y': (0.49, 0.92), 'groups': [('西1', 'むみまほへ'),
                                           ('西2', 'かおえうい')]},
        ],
    },
    {   # South 1/2 - latin lowercase, a single band
        'page': 4,
        'halls': ['南1', '南2'],
        'walls': [{'block': 'a', 'hall': '南 壁'}],
        'bands': [{'y': (0.15, 0.70), 'groups': [('南1', 'tsrqponmlk'),
                                                 ('南2', 'jihgfedcb')]}],
    },
]


def main(pdf: str, out_path: str) -> None:
    doc = {'event': os.path.basename(pdf).split('Map')[0] or 'map',
           'source': os.path.basename(pdf),
           'sha256': hashlib.sha256(open(pdf, 'rb').read()).hexdigest(),
           'pages': []}

    with tempfile.TemporaryDirectory() as tmp:
        for meta in PAGES:
            page = meta['page']
            w_pt, h_pt = page_size(pdf, page)
            img = render_page(pdf, page, tmp)
            dark = img < DARK
            runs = list(horizontal_runs(dark))
            width = island_width(runs)

            entries = []
            for band in meta['bands']:
                entries += blocks_in_band(dark, runs, width, band, img.shape[0])
            blocks = [to_json_block(e, h_pt) for e in entries]

            print(f'page {page}: {len(blocks)} blocks, '
                  f'{sum(b["count"] for b in blocks)} spaces')
            for b in blocks:
                print(f'   {b["hall"]:>3} {b["block"]:>2}  N={b["count"]:3d}  '
                      f'x={b["x"]:6.1f}')
            doc['pages'].append({'index': page - 1, 'width': w_pt, 'height': h_pt,
                                 'halls': meta['halls'], 'blocks': blocks,
                                 'walls': meta.get('walls', [])})

    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'wrote {out_path}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'data/layout.json')
