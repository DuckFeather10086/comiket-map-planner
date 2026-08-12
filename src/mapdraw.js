/**
 * Where every space sits on the official map.
 *
 * `data/*.json` carries the PDF-space rectangle of every island row and of
 * every printed wall strip, which is all the marker layer and the click targets
 * need.  A wall strip is a run of consecutive numbers in one printed ladder:
 * `from`..`to` share the rectangle and are cut into equal cells along `axis`,
 * counting from the low end - so a strip whose numbers run the other way just
 * has `from` greater than `to`.  The slanted wall in East 7 carries `a`, the
 * angle its cells are laid along, instead of an axis.
 */

const PAD = 30;          // breathing room around a hall, used by the zoom sheets
const HEADER = 34;       // strip above a zoom sheet for its title

/** How many spaces a strip holds. */
export const stripCount = strip => Math.abs(strip.to - strip.from) + 1;

/** The corners of a rectangle, going round, in source PDF coordinates. */
export function corners(rect) {
  if (!rect.a) {
    return [[rect.x, rect.y], [rect.x + rect.w, rect.y],
            [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]];
  }
  const rad = rect.a * Math.PI / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  return [[0, 0], [rect.w, 0], [rect.w, rect.h], [0, rect.h]].map(
    ([s, t]) => [rect.x + s * ux - t * uy, rect.y + s * uy + t * ux]);
}

/** Rectangle of one space inside a wall strip, or null if it is not in it. */
export function stripCellRect(strip, number) {
  const count = stripCount(strip);
  const index = strip.to >= strip.from ? number - strip.from : strip.from - number;
  if (index < 0 || index >= count) return null;

  if (strip.a) {
    const step = strip.w / count;
    const rad = strip.a * Math.PI / 180;
    return { x: strip.x + Math.cos(rad) * step * index,
             y: strip.y + Math.sin(rad) * step * index,
             w: step, h: strip.h, a: strip.a };
  }
  if (strip.axis === 'y') {
    const step = strip.h / count;
    return { x: strip.x, y: strip.y + step * index, w: strip.w, h: step };
  }
  const step = strip.w / count;
  return { x: strip.x + step * index, y: strip.y, w: step, h: strip.h };
}

/** Whether a point in source PDF coordinates falls inside a rectangle. */
export function inRect(rect, px, py) {
  let x = px - rect.x, y = py - rect.y;
  if (rect.a) {
    const rad = -rect.a * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    [x, y] = [x * cos - y * sin, x * sin + y * cos];
  }
  return x >= 0 && x <= rect.w && y >= 0 && y <= rect.h;
}

/**
 * Geometry of one hall panel: the blocks and wall strips it contains and the
 * box they occupy.  Coordinates stay in the source PDF space; the pen applies
 * the transform.
 */
export function hallPanel(layout, pageIndex, hall) {
  const page = layout.page(pageIndex);
  const blocks = page.blocks.filter(b => b.hall === hall);
  if (!blocks.length) return null;
  const strips = (page.wallStrips || []).filter(s => s.hall === hall);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const stretch = (x, y) => {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  };
  for (const b of blocks) {
    for (const [ry0, ry1] of b.rows) {
      stretch(b.x, ry0);
      stretch(b.x + b.w, ry1);
    }
  }
  // the wall runs outside the islands, and a zoom sheet has to reach it
  for (const strip of strips) {
    for (const [x, y] of corners(strip)) stretch(x, y);
  }

  const box = { x: x0 - PAD, y: y0 - PAD,
                w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
  return { hall, pageIndex, blocks, strips, box, header: HEADER };
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

/** Which space a point on a map page lands on, or null. */
export function hitTestPage(layout, pageIndex, px, py) {
  const page = layout.page(pageIndex);
  for (const block of page.blocks) {
    if (px < block.x - 1 || px > block.x + block.w + 1) continue;
    for (let n = 1; n <= block.count; n++) {
      if (inRect(cellRect(block, n), px, py)) {
        return { block: block.block, hall: block.hall, number: n };
      }
    }
  }
  for (const strip of page.wallStrips || []) {
    if (!inRect(strip, px, py)) continue;
    const step = strip.to >= strip.from ? 1 : -1;
    for (let i = 0; i < stripCount(strip); i++) {
      const number = strip.from + step * i;
      if (inRect(stripCellRect(strip, number), px, py)) {
        return { block: strip.block, hall: strip.hall, number, wall: true };
      }
    }
  }
  return null;
}

/** Key used when looking a marker up by block and number. */
export const markKey = (block, number) => `${block}-${number}`;
