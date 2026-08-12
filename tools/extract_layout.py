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
import math
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
def render_page(pdf: str, page: int, tmpdir: str, dpi: int = DPI) -> np.ndarray:
    stem = os.path.join(tmpdir, f'page{page}-{dpi}')
    subprocess.run(['pdftoppm', '-gray', '-png', '-r', str(dpi),
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
# wall strips
# --------------------------------------------------------------------------- #
# Wall blocks (壁サークル) are printed as short ladders of cells butted against
# the hall walls, broken up by pillars and doorways and stepping in and out with
# the building outline, so there is no single grid covering a whole block.  Each
# ladder is regular though, so the same trick as the islands works: find the two
# rails, cut the run into equal cells, and count them.
#
# What is declared by hand per run is the band to look in, the direction the
# printed numbers count in, and the first and last of them - all read straight
# off the map.  The ladders inside the band, their positions and their cell
# counts all come out of the raster, and the run only survives if the cells found
# add up to the numbers declared.

# the rules round a wall cell are hairlines: the uprights come out solid but the
# long rails often rasterise as pale grey, so they get their own threshold
WALL_FAINT = 235
WALL_DEPTH = (3.0, 13.0)     # a wall cell reaches this far into the hall
WALL_CELL = (5.5, 14.0)      # and is this long, along the wall


def band_pixels(grey, page_h, origin, angle, length, depth, smear):
    """Rasterise a strip-frame band: rows run across the wall, columns along it.

    Sampling in the strip's own frame means a wall at any angle - the diagonal
    one in East 7 - is handed to the detector already square.  Grey levels are
    kept because the cell rails need a softer threshold than everything else.
    """
    cols, rows = int(round(length * PX)), int(round(depth * PX))
    rad = math.radians(angle)
    ux, uy = math.cos(rad), math.sin(rad)
    along = (np.arange(cols) + 0.5) / PX
    across = (np.arange(rows) + 0.5) / PX
    x = origin[0] + np.outer(np.ones(rows), along) * ux - np.outer(across, np.ones(cols)) * uy
    y = origin[1] + np.outer(np.ones(rows), along) * uy + np.outer(across, np.ones(cols)) * ux

    def sample(dx, dy):
        px = np.clip((x * PX + dx).astype(int), 0, grey.shape[1] - 1)
        py = np.clip(((page_h - y) * PX + dy).astype(int), 0, grey.shape[0] - 1)
        return grey[py, px]

    band = sample(0, 0)
    if smear:      # a slanted band lands between pixels and breaks up thin rails
        band = np.minimum(band, np.minimum(sample(1, 0), sample(0, 1)))
    return band


def column_runs(band, lo, hi):
    """(column, first row, last row) for ink runs of a plausible cell depth."""
    out = []
    for c in range(band.shape[1]):
        col = band[:, c]
        if not col.any():
            continue
        edges = np.flatnonzero(np.diff(np.concatenate(([0], col.view(np.int8), [0]))))
        for a, b in zip(edges[0::2], edges[1::2]):
            if lo <= (b - a) / PX <= hi:
                out.append((c, int(a), int(b - 1)))
    return out


def rail_groups(runs):
    """Split runs into sets sharing a pair of rails.

    One column can carry runs from two strips at once where a band covers both
    an outer and an inner wall, so the runs have to be sorted by their ends
    before anything else is done with them.
    """
    tally: dict[tuple[int, int], int] = {}
    for _, a, b in runs:
        tally[(a, b)] = tally.get((a, b), 0) + 1

    groups, taken = [], set()
    for ends in sorted(tally, key=lambda k: -tally[k]):
        # claiming runs, not just the key, keeps overlapping tolerance windows
        # from reporting one ladder twice
        members = [i for i, r in enumerate(runs)
                   if i not in taken
                   and abs(r[1] - ends[0]) <= 2 and abs(r[2] - ends[1]) <= 2]
        if len(members) >= 2:
            taken.update(members)
            groups.append([runs[i] for i in members])
    return groups


def separators(runs):
    """Collapse column runs into one entry per printed cell edge.

    A cell edge is two or three pixels wide and reaches from rail to rail, so
    neighbouring columns that agree on both ends are the same edge.
    """
    out = []
    for col, top, bottom in sorted(runs):
        last = out[-1] if out else None
        if (last and col - last[-1] <= 2
                and abs(top - last[1]) <= 2 and abs(bottom - last[2]) <= 2):
            out[-1] = (last[0], min(last[1], top), max(last[2], bottom), col)
        else:
            out.append((col, top, bottom, col))
    return [((a + d) // 2, t, b) for a, t, b, d in out]


def edge_gaps(edges):
    """Distances between neighbouring cell edges that could be one cell."""
    return [b[0] - a[0] for a, b in zip(edges, edges[1:])
            if WALL_CELL[0] * PX <= b[0] - a[0] <= WALL_CELL[1] * PX
            and abs(a[1] - b[1]) <= 2 and abs(a[2] - b[2]) <= 2]


def cell_pitch(gaps) -> float:
    """Cell width in pixels, from the gaps between neighbouring cell edges.

    One run of wall numbers is printed to a single pitch throughout, so the gap
    that comes up again and again is it; the odd double gap where a digit was
    inked over an edge, and whatever the band caught besides the wall, are
    outvoted.  Taking one pitch for the whole band and not per ladder is what
    lets a boxed-in label be told from a strip of spaces.
    """
    if not gaps:
        return 0.0
    rough = statistics.median(gaps)
    tight = [d for d in gaps if 0.75 * rough <= d <= 1.25 * rough]
    return statistics.median(tight) if tight else rough


def ladders_in_band(band):
    """Every printed ladder in a band, as (row0, row1, col0, col1, cells).

    A ladder is a chain of cell edges sharing a pair of rails and a whole
    number of cells apart, with the rails unbroken in between.  Those three
    conditions are what tell two ladders either side of a pillar apart, keep
    ladders at different depths - the strips step in and out with the building
    outline - from being spliced together, and recover an edge that a digit was
    drawn over as a double-width gap.
    """
    ink, faint = band < DARK, band < WALL_FAINT
    groups = [separators(items)
              for items in rail_groups(column_runs(ink, *WALL_DEPTH))]
    pitch = cell_pitch([g for edges in groups for g in edge_gaps(edges)])
    if not pitch:
        return []

    out = []
    for edges in groups:
        found, chain, cells = [], None, 0
        for edge, nxt in zip(edges, edges[1:] + [None]):
            if chain is None:
                chain = edge
            if nxt is None:
                found.append(ladder(ink, chain, edge, cells, pitch))
                break
            gap = nxt[0] - edge[0]
            n = round(gap / pitch)
            if (1 <= n <= 3 and abs(gap - n * pitch) <= 0.3 * pitch
                    and abs(edge[1] - nxt[1]) <= 2 and abs(edge[2] - nxt[2]) <= 2
                    and joined(faint, edge, nxt)):
                cells += n
            else:
                found.append(ladder(ink, chain, edge, cells, pitch))
                chain, cells = None, 0
        out += [grow(ink, faint, f, pitch) for f in keep_ladders(found)]
    return out


def grow(ink, faint, lad, pitch):
    """Reach one cell either side for an edge that was lost.

    The last cell of a strip often butts straight onto a black structure, which
    swallows its outer edge; the pitch says exactly where that edge would be, so
    it is worth going to look, as long as what gets taken in really is a cell.
    """
    r0, r1, c0, c1, cells = lad
    for side in (-1, 1):
        col = int(round((c0 if side < 0 else c1) + side * pitch))
        if not 0 <= col < faint.shape[1]:
            continue
        lo, hi = (col, c0) if side < 0 else (c1, col)
        edge = faint[r0:r1 + 1, max(0, col - 1):col + 2].any(axis=1)
        if edge.mean() < 0.98 or not joined(faint, (lo, r0, r1), (hi, r0, r1)):
            continue
        inside = ink[r0 + 2:max(r0 + 3, r1 - 1), lo:hi + 1]
        if inside.size and (inside.all(axis=0).mean() > 0.5
                            or inside.mean() > 0.85):
            continue
        c0, c1, cells = min(c0, lo), max(c1, hi), cells + 1
    return (r0, r1, c0, c1, cells)


def joined(faint, edge, nxt) -> bool:
    """Whether both rails run unbroken from one cell edge to the next.

    This is what a pillar or a doorway breaks, and it is the only thing that
    separates two ladders whose gap happens to measure a whole cell or two.
    """
    lo, hi = edge[0], nxt[0]
    top = faint[max(0, edge[1] - 1):edge[1] + 2, lo:hi + 1].any(axis=0)
    bottom = faint[max(0, edge[2] - 1):edge[2] + 2, lo:hi + 1].any(axis=0)
    return bool((top & bottom).mean() > 0.95)


def ladder(ink, first, last, cells, pitch):
    """One candidate ladder, with a note of whether its cells are filled in."""
    # a run of wall numbers is printed to one pitch throughout, so a chain whose
    # cells come out a different size is something else that happens to be boxed
    if cells < 1 or abs((last[0] - first[0]) / cells - pitch) > 0.3 * pitch:
        return None
    r0 = min(first[1], last[1])
    r1 = max(first[2], last[2])
    inside = ink[r0 + 2:max(r0 + 3, r1 - 1), first[0]:last[0] + 1]
    filled = inside.all(axis=0).mean() if inside.size else 0
    solid = bool(inside.size and (filled > 0.5 or inside.mean() > 0.85))
    return (r0, r1, first[0], last[0], cells, solid)


def keep_ladders(found):
    """Drop the solid candidates: printed cells hold a number and little else,
    so anything filled in is a pillar, a black structure or the cover art."""
    return [f[:5] for f in found if f and not f[5]]


def dedupe(ladders):
    """One ladder per stretch of wall.

    A slanted band is sampled off the pixel grid, which can thicken a rail
    enough to report the same ladder twice at depths a pixel apart.
    """
    out = []
    for lad in sorted(ladders, key=lambda l: (l[2], l[2] - l[3])):
        if any(lad[2] <= o[3] and o[2] <= lad[3] for o in out):
            continue
        out.append(lad)
    return out


def wall_strips(grey, page_h, block, run, halls) -> list[dict]:
    """One declared run of wall numbers, resolved to placed strips of cells."""
    origin, angle, length, depth = run['at']
    band = band_pixels(grey, page_h, origin, angle, length, depth,
                       smear=angle % 90 != 0)
    found = dedupe(ladders_in_band(band))

    step = 1 if run['to'] >= run['from'] else -1
    skip = set(run.get('skip', ()))
    numbers = [n for n in range(run['from'], run['to'] + step, step)
               if n not in skip]

    total = sum(l[4] for l in found)
    if total != len(numbers):
        print(f'  !! {block} {run["from"]}-{run["to"]}: found {total} cells in '
              f'{len(found)} ladders, expected {len(numbers)}', file=sys.stderr)
        return []

    rad = math.radians(angle)
    ux, uy = math.cos(rad), math.sin(rad)

    out, taken = [], 0
    for r0, r1, c0, c1, n in found:
        s0, s1 = c0 / PX, (c1 + 1) / PX
        t0, t1 = r0 / PX, (r1 + 1) / PX
        corners = [(origin[0] + s * ux - t * uy, origin[1] + s * uy + t * ux)
                   for s, t in ((s0, t0), (s1, t0), (s1, t1), (s0, t1))]
        head, tail = numbers[taken], numbers[taken + n - 1]
        taken += n

        strip = {'block': block, 'from': head, 'to': tail}
        if angle % 90:
            strip.update(x=round(corners[0][0], 2), y=round(corners[0][1], 2),
                         w=round(s1 - s0, 2), h=round(t1 - t0, 2), a=angle)
        else:
            xs = [c[0] for c in corners]
            ys = [c[1] for c in corners]
            strip.update(x=round(min(xs), 2), y=round(min(ys), 2),
                         w=round(max(xs) - min(xs), 2),
                         h=round(max(ys) - min(ys), 2),
                         axis='x' if angle % 180 == 0 else 'y')
        strip['hall'] = nearest_hall(halls, strip)
        out.append(strip)
    return out


def nearest_hall(halls, strip) -> str:
    """The hall a strip belongs to: the one whose islands it sits closest to."""
    cx, cy = strip['x'] + strip['w'] / 2, strip['y'] + strip['h'] / 2
    best, score = None, None
    for hall, (x0, y0, x1, y1) in halls.items():
        d = math.hypot(max(x0 - cx, 0, cx - x1), max(y0 - cy, 0, cy - y1))
        if score is None or d < score:
            best, score = hall, d
    return best


def hall_boxes(blocks) -> dict:
    boxes = {}
    for b in blocks:
        rows = b['rows']
        box = boxes.setdefault(b['hall'], [b['x'], rows[0][0],
                                          b['x'] + b['w'], rows[-1][1]])
        box[0] = min(box[0], b['x'])
        box[1] = min(box[1], min(r[0] for r in rows))
        box[2] = max(box[2], b['x'] + b['w'])
        box[3] = max(box[3], max(r[1] for r in rows))
    return boxes


# --------------------------------------------------------------------------- #
# per-page metadata, read off the printed map
# --------------------------------------------------------------------------- #
# `at` is (origin, angle, length, depth): the corner a run starts from, the
# direction its numbers count in, and how far the band reaches along and into
# the hall.  `from`/`to` are the printed numbers at the two ends.  Numbers with
# no printed cell - ア 89-92, あ 16-21 - simply fall outside every run and are
# reported as unplaced rather than guessed at.
PAGES = [
    {   # East 1/2/3 - katakana blocks, a single full-height band
        'page': 1,
        'halls': ['東3', '東2', '東1'],
        'walls': [{'block': 'ア', 'hall': '東 壁', 'runs': [
            # up East 1's right wall, left along the top of all three halls,
            # then down East 3's left wall; 89-92 are not printed
            {'at': ((1012, 246), 90, 305, 30), 'from': 1, 'to': 22},
            {'at': ((60, 556), 0, 930, 28), 'from': 73, 'to': 23},
            {'at': ((74, 300), 90, 255, 42), 'from': 88, 'to': 74},
            {'at': ((74, 245), 90, 55, 42), 'from': 95, 'to': 93},
        ]}],
        'bands': [{'y': (0.15, 0.70), 'groups': [
            ('東3', 'ヨユヤモメムミマホヘフヒハノネヌニ'),
            ('東2', 'ナトテツチタソセスシサコケ'),
            ('東1', 'クキカオエウイ')]}],
    },
    {   # East 7 - latin capitals, two bands
        'page': 2,
        'halls': ['東7'],
        'walls': [{'block': 'A', 'hall': '東7 壁', 'runs': [
            # 1-18 climb the slanted south-east wall, whose angle is measured
            # off the printed outline; then left along the top and down the
            # left-hand wall
            {'at': ((362.02, 88.37), 57.935, 305, 24), 'from': 1, 'to': 18},
            {'at': ((70, 610), 0, 340, 26), 'from': 34, 'to': 19},
            {'at': ((114, 110), 90, 220, 40), 'from': 48, 'to': 35},
        ]}],
        'bands': [
            {'y': (0.12, 0.50), 'groups': [('東7', 'MLKJIHGFEDCB')]},
            {'y': (0.50, 0.86), 'groups': [('東7', 'WVUTSRQPON')]},
        ],
    },
    {   # West 1/2 - hiragana blocks, two bands
        'page': 3,
        'halls': ['西1', '西2'],
        'walls': [
            {'block': 'め', 'hall': '西1 壁', 'runs': [
                {'at': ((80, 52), 0, 300, 30), 'from': 15, 'to': 1},
                # 20 is blacked out on the printed map, so it has no cell to point at
                {'at': ((100, 80), 90, 575, 44), 'from': 16, 'to': 39,
                 'skip': [20]},
                {'at': ((90, 645), 0, 420, 30), 'from': 40, 'to': 57},
            ]},
            # West 2 mirrors West 1, but has no printed 16-21
            {'block': 'あ', 'hall': '西2 壁', 'runs': [
                {'at': ((745, 52), 0, 220, 30), 'from': 1, 'to': 15},
                {'at': ((975, 190), 90, 465, 44), 'from': 22, 'to': 39,
                 'skip': [35]},
                {'at': ((530, 645), 0, 420, 30), 'from': 57, 'to': 40},
            ]},
        ],
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
        'walls': [{'block': 'a', 'hall': '南 壁', 'runs': [
            # a full lap: right along the bottom of South 2, up the right wall,
            # left along the top, down the left wall, right along the bottom of
            # South 1
            {'at': ((865, 205), 0, 90, 48), 'from': 1, 'to': 4},
            {'at': ((985, 225), 90, 385, 55), 'from': 5, 'to': 20},
            {'at': ((80, 588), 0, 880, 46), 'from': 44, 'to': 21},
            {'at': ((110, 222), 90, 115, 50), 'from': 50, 'to': 45},
            {'at': ((385, 205), 0, 100, 48), 'from': 51, 'to': 54},
        ]}],
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

            halls = hall_boxes(blocks)
            strips, walls = [], []
            for wall in meta.get('walls', []):
                for run in wall.get('runs', []):
                    strips += wall_strips(img, h_pt, wall['block'], run, halls)
                walls.append({'block': wall['block'], 'hall': wall['hall']})

            print(f'page {page}: {len(blocks)} blocks, '
                  f'{sum(b["count"] for b in blocks)} spaces, '
                  f'{sum(abs(s["to"] - s["from"]) + 1 for s in strips)} wall spaces')
            for b in blocks:
                print(f'   {b["hall"]:>3} {b["block"]:>2}  N={b["count"]:3d}  '
                      f'x={b["x"]:6.1f}')
            doc['pages'].append({'index': page - 1, 'width': w_pt, 'height': h_pt,
                                 'halls': meta['halls'], 'blocks': blocks,
                                 'walls': walls, 'wallStrips': strips})

    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'wrote {out_path}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'data/layout.json')
