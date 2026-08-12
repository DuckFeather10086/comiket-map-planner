/**
 * The map itself, drawn from the extracted space rectangles.
 *
 * There is no traced artwork here: every space in `data/*.json` already carries
 * its rectangle in PDF points, which is all a hall map really is - position plus
 * number.  One routine emits the drawing through an abstract pen so the screen
 * canvas and the exported PDF cannot drift apart, and the same geometry answers
 * hit-tests when a cell is clicked.
 */

import { colorOf } from './layout.js';

/** Ink and paper, kept in one place so both backends agree. */
export const THEME = {
  paper: [1, 1, 1],
  frame: [0.78, 0.81, 0.85],
  island: [0.96, 0.97, 0.98],
  islandEdge: [0.62, 0.66, 0.72],
  cellEdge: [0.80, 0.83, 0.87],
  number: [0.25, 0.30, 0.36],
  letter: [0.08, 0.10, 0.13],
  hall: [0.10, 0.12, 0.16],
  dim: [0.55, 0.60, 0.66],
};

const PAD = 30;          // points of breathing room, enough to show the walls
const HEADER = 34;       // strip above the map for the hall name and notes

/**
 * Geometry of one hall panel: the blocks it contains and the box they occupy.
 * Coordinates stay in the source PDF space; the pen applies the transform.
 */
export function hallPanel(layout, pageIndex, hall) {
  const blocks = layout.page(pageIndex).blocks.filter(b => b.hall === hall);
  if (!blocks.length) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of blocks) {
    x0 = Math.min(x0, b.x);
    x1 = Math.max(x1, b.x + b.w);
    for (const [ry0, ry1] of b.rows) {
      y0 = Math.min(y0, ry0);
      y1 = Math.max(y1, ry1);
    }
  }
  const box = { x: x0 - PAD, y: y0 - PAD,
                w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
  // the building is stored per page; keep the parts this hall's sheet shows,
  // clipped to the sheet so a neighbouring hall's walls do not bleed in
  const structures = [];
  for (const s of layout.page(pageIndex).structures || []) {
    const cx0 = Math.max(s.x, box.x), cy0 = Math.max(s.y, box.y);
    const cx1 = Math.min(s.x + s.w, box.x + box.w);
    const cy1 = Math.min(s.y + s.h, box.y + box.h);
    if (cx1 - cx0 > 0.4 && cy1 - cy0 > 0.4) {
      structures.push({ x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0, tone: s.tone });
    }
  }
  const runs = (layout.doc.wallRuns || [])
    .filter(r => r.page === pageIndex && r.hall === hall);
  return { hall, pageIndex, blocks, structures, box, runs, header: HEADER };
}

/** Every hall on the event, in map order. */
export function allPanels(layout) {
  const out = [];
  layout.pages.forEach((page, index) => {
    for (const hall of page.halls) {
      const panel = hallPanel(layout, index, hall);
      if (panel) out.push(panel);
    }
  });
  return out;
}

/** The contiguous vertical runs of a block's rows, i.e. its island sections. */
export function sections(block) {
  const runs = [];
  let cur = [block.rows[0]];
  for (let i = 1; i < block.rows.length; i++) {
    const [y0] = block.rows[i];
    const prevTop = cur[cur.length - 1][1];
    if (y0 - prevTop > 1.2) {
      runs.push(cur);
      cur = [block.rows[i]];
    } else {
      cur.push(block.rows[i]);
    }
  }
  runs.push(cur);
  return runs;
}

const WALL_T = 8;        // how deep a wall cell reaches into the hall
const WALL_GAP = 2;      // clearance between the wall strip and the hall edge

/** The spaces a wall run actually has, skipping numbers that are not sold. */
export function runNumbers(run) {
  const skip = new Set(run.missing || []);
  const out = [];
  for (let n = run.from; n <= run.to; n++) if (!skip.has(n)) out.push(n);
  return out;
}

/**
 * Rectangle of one wall space, laid out along the hall edge it belongs to.
 *
 * The printed strips wrap corners at an uneven pitch and are broken up by
 * pillars, none of which a line-drawn hall reproduces; what has to be right is
 * the wall, the order and the number, so the run is spread evenly along its
 * edge.  Position along the wall is therefore approximate by a cell or two.
 */
export function wallCellRect(panel, run, number) {
  const nums = runNumbers(run);
  const i = nums.indexOf(number);
  if (i < 0) return null;
  const { box } = panel;
  const vertical = run.side === 'left' || run.side === 'right';
  const span = (vertical ? box.h : box.w) - WALL_GAP * 2;
  const step = span / nums.length;
  const k = run.reverse ? nums.length - 1 - i : i;
  const along = (vertical ? box.y : box.x) + WALL_GAP + k * step;

  if (vertical) {
    const x = run.side === 'left' ? box.x + WALL_GAP : box.x + box.w - WALL_GAP - WALL_T;
    return { x, y: along, w: WALL_T, h: step };
  }
  const y = run.side === 'top' ? box.y + box.h - WALL_GAP - WALL_T : box.y + WALL_GAP;
  return { x: along, y, w: step, h: WALL_T };
}

/** Rectangle of one space, in source PDF coordinates. */
export function cellRect(block, number) {
  const half = block.count / 2;
  let row, right;
  if (number <= half) {
    row = number - 1;
    right = true;
  } else {
    row = block.count - number;
    right = false;
  }
  if (block.mirror) right = !right;
  const [y0, y1] = block.rows[row];
  const hw = block.w / 2;
  const x = block.x + (right ? hw : 0);
  return { x, y: y0, w: hw, h: y1 - y0 };
}

/** Which space a point lands on, or null. Used for click-to-mark. */
export function hitTest(panel, px, py) {
  for (const run of panel.runs || []) {
    for (const n of runNumbers(run)) {
      const r = wallCellRect(panel, run, n);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { block: run.block, hall: run.hall, number: n, wall: true };
      }
    }
  }
  for (const block of panel.blocks) {
    if (px < block.x - 1 || px > block.x + block.w + 1) continue;
    for (let n = 1; n <= block.count; n++) {
      const r = cellRect(block, n);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { block: block.block, hall: block.hall, number: n };
      }
    }
  }
  return null;
}

/**
 * Draw one hall panel.
 *
 * @param pen        drawing backend (see CanvasPen / PdfPen)
 * @param panel      from hallPanel()
 * @param marks      Map from "<block>-<number>" to {index, color}
 * @param options    {showNumbers, title}
 */
export function drawPanel(pen, panel, marks = new Map(), options = {}) {
  const { box } = panel;
  const showNumbers = options.showNumbers !== false;

  pen.rect(box.x, box.y, box.w, box.h, { fill: THEME.paper });

  // the building first, so the tables sit on top of it
  for (const s of panel.structures) {
    const g = 1 - Math.min(0.86, s.tone * 0.92);
    pen.rect(s.x, s.y, s.w, s.h, { fill: [g, g * 1.02, g * 1.05] });
  }

  for (const block of panel.blocks) {
    for (const run of sections(block)) {
      const top = run[run.length - 1][1];
      const bottom = run[0][0];
      pen.rect(block.x, bottom, block.w, top - bottom,
               { fill: THEME.island, stroke: THEME.islandEdge, lineWidth: 0.6 });
    }

    for (let n = 1; n <= block.count; n++) {
      const r = cellRect(block, n);
      const mark = marks.get(`${block.block}-${n}`);
      if (mark) {
        pen.rect(r.x, r.y, r.w, r.h, { fill: colorOf(mark.color).rgb });
      }
      pen.rect(r.x, r.y, r.w, r.h, { stroke: THEME.cellEdge, lineWidth: 0.3 });
      if (showNumbers) {
        pen.text(String(n), r.x + r.w / 2, r.y + r.h / 2, {
          size: Math.min(r.h * 0.66, r.w * 0.52),
          align: 'center', middle: true,
          color: mark ? THEME.paper : THEME.number,
          weight: mark ? 700 : 400,
        });
      }
    }

    // block letter in the widest aisle inside the strip
    let gap = 0, gy = null;
    for (let i = 1; i < block.rows.length; i++) {
      const d = block.rows[i][0] - block.rows[i - 1][1];
      if (d > gap) {
        gap = d;
        gy = (block.rows[i][0] + block.rows[i - 1][1]) / 2;
      }
    }
    if (gy !== null && gap > 4) {
      pen.text(block.block, block.x + block.w / 2, gy, {
        size: Math.min(gap * 0.78, block.w * 0.85),
        align: 'center', middle: true, color: THEME.letter, weight: 700,
      });
    }
  }

  for (const run of panel.runs || []) {
    for (const n of runNumbers(run)) {
      const r = wallCellRect(panel, run, n);
      const mark = marks.get(`${run.block}-${n}`);
      pen.rect(r.x, r.y, r.w, r.h, {
        fill: mark ? colorOf(mark.color).rgb : THEME.island,
        stroke: THEME.islandEdge, lineWidth: 0.4,
      });
      if (showNumbers) {
        pen.text(String(n), r.x + r.w / 2, r.y + r.h / 2, {
          size: Math.min(r.h * 0.6, r.w * 0.6, 6),
          align: 'center', middle: true,
          color: mark ? THEME.paper : THEME.number, weight: mark ? 700 : 400,
        });
      }
    }
    const mid = runNumbers(run)[Math.floor(runNumbers(run).length / 2)];
    const r = wallCellRect(panel, run, mid);
    const vertical = run.side === 'left' || run.side === 'right';
    pen.text(run.block, vertical ? r.x + r.w + 5 : r.x + r.w / 2,
             vertical ? r.y + r.h / 2 : r.y + (run.side === 'top' ? -6 : r.h + 3), {
      size: 8, align: 'center', middle: vertical, color: THEME.letter, weight: 700,
    });
  }

  // marker badges last so they sit above the grid
  for (const block of panel.blocks) {
    for (let n = 1; n <= block.count; n++) {
      const mark = marks.get(`${block.block}-${n}`);
      if (!mark) continue;
      const r = cellRect(block, n);
      const rightHalf = r.x > block.x + block.w / 4;
      const bx = (rightHalf ? r.x + r.w : r.x) + (rightHalf ? 1 : -1) * 4.4;
      const by = r.y + r.h / 2;
      pen.circle(bx, by, 4.2, { fill: colorOf(mark.color).rgb, stroke: THEME.paper,
                                lineWidth: 0.7 });
      pen.text(String(mark.index), bx, by, {
        size: String(mark.index).length > 2 ? 4.2 : 5.2,
        align: 'center', middle: true, color: THEME.paper, weight: 700,
      });
    }
  }

  for (const run of panel.runs || []) {
    for (const n of runNumbers(run)) {
      const mark = marks.get(`${run.block}-${n}`);
      if (!mark) continue;
      const r = wallCellRect(panel, run, n);
      const vertical = run.side === 'left' || run.side === 'right';
      const bx = vertical ? (run.side === 'left' ? r.x + r.w + 4.6 : r.x - 4.6)
                          : r.x + r.w / 2;
      const by = vertical ? r.y + r.h / 2
                          : (run.side === 'top' ? r.y - 4.6 : r.y + r.h + 4.6);
      pen.circle(bx, by, 4.2, { fill: colorOf(mark.color).rgb, stroke: THEME.paper,
                                lineWidth: 0.7 });
      pen.text(String(mark.index), bx, by, {
        size: String(mark.index).length > 2 ? 4.2 : 5.2,
        align: 'center', middle: true, color: THEME.paper, weight: 700,
      });
    }
  }

  if (options.title !== false) {
    pen.text(options.title || panel.hall, box.x + 4, box.y + box.h + 12,
             { size: 15, color: THEME.hall, weight: 700 });
    const spaces = panel.blocks.reduce((n, b) => n + b.count, 0);
    pen.text(`${panel.blocks.length} blocks / ${spaces} spaces  `
             + panel.blocks.map(b => b.block).join(''),
             box.x + 4, box.y + box.h + 3, { size: 7, color: THEME.dim });
  }

  drawNotes(pen, box, options.notes);
}

/**
 * Entries this map cannot place: wall blocks, whose spaces wrap around the hall
 * walls with no regular grid to extract, and codes we could not read.  They are
 * listed on the sheet rather than pinned at a guessed position.
 */
const NOTE_LIMIT = 3;

function drawNotes(pen, box, notes) {
  if (!notes || !notes.length) return;
  const size = 6.5;
  const lead = size * 1.5;
  const right = box.x + box.w - 4;
  // sits in the header strip, right-aligned, so it clears the hall title on the
  // left and the grid below
  let y = box.y + box.h + HEADER - lead * 1.4;

  pen.text('壁 (off-grid)', right, y, {
    size, align: 'right', color: THEME.dim, weight: 700,
  });
  for (const note of notes.slice(0, NOTE_LIMIT)) {
    y -= lead;
    pen.circle(right - 3, y + size * 0.32, 3, { fill: colorOf(note.color).rgb });
    pen.text(String(note.index), right - 3, y + size * 0.32,
             { size: 3.8, align: 'center', middle: true, color: THEME.paper,
               weight: 700 });
    pen.text(note.code, right - 9, y, { size, align: 'right', color: THEME.number });
  }
  if (notes.length > NOTE_LIMIT) {
    y -= lead;
    pen.text(`+${notes.length - NOTE_LIMIT} more (see checklist)`, right, y,
             { size, align: 'right', color: THEME.dim });
  }
}

/** Key used by the marks map. */
export const markKey = (block, number) => `${block}-${number}`;
