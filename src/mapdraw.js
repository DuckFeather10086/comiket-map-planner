/**
 * Where every space sits on the official map.
 *
 * `data/*.json` carries the PDF-space rectangle of each island row, which is
 * all the marker layer and the click targets need.  Wall spaces have no regular
 * grid to extract, so their declared runs are laid evenly along the hall edge -
 * right wall, right order, right number, with the position along the wall good
 * to a cell or two.
 */

const PAD = 30;          // breathing room around a hall, used by the zoom sheets
const HEADER = 34;       // strip above a zoom sheet for its title
const WALL_T = 8;        // how deep a wall cell reaches into the hall
const WALL_GAP = 2;      // clearance between the wall strip and the hall edge

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
  const runs = (layout.doc.wallRuns || [])
    .filter(r => r.page === pageIndex && r.hall === hall);
  const wallLines = (layout.page(pageIndex).wallLines || {})[hall] || [];
  return { hall, pageIndex, blocks, box, runs, wallLines, header: HEADER };
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
  // horizontal runs stop short of the corners so they do not collide with a
  // vertical run on the same hall
  const inset = WALL_GAP + (vertical ? 0 : WALL_T);
  const span = (vertical ? box.h : box.w) - inset * 2;
  const step = span / nums.length;
  const k = run.reverse ? nums.length - 1 - i : i;
  const along = (vertical ? box.y : box.x) + inset + k * step;

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

/**
 * Which space a point on a map page lands on, or null.
 *
 * Islands are exact.  Wall runs are laid evenly along the hall edge because the
 * printed strips have no regular grid, so they answer within a cell or two -
 * good enough to click, and the printed number underneath settles it.
 */
export function hitTestPage(layout, pageIndex, px, py) {
  const page = layout.page(pageIndex);
  for (const block of page.blocks) {
    if (px < block.x - 1 || px > block.x + block.w + 1) continue;
    for (let n = 1; n <= block.count; n++) {
      const r = cellRect(block, n);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { block: block.block, hall: block.hall, number: n };
      }
    }
  }
  for (const panel of allPanels(layout)) {
    if (panel.pageIndex !== pageIndex) continue;
    for (const run of panel.runs) {
      for (const n of runNumbers(run)) {
        const r = wallCellRect(panel, run, n);
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
          return { block: run.block, hall: run.hall, number: n, wall: true };
        }
      }
    }
  }
  return null;
}

/** Key used when looking a marker up by block and number. */
export const markKey = (block, number) => `${block}-${number}`;
