/**
 * The cover sheet: where the halls are in the venue.
 *
 * The official map prints a small plan of the whole site in the corner of one of
 * its sheets - the only drawing that shows how the East, West and South
 * buildings sit relative to each other.  That corner is measured into
 * `data/*.json` (see tools/extract_layout.py), so the sheet here is that same
 * page copied once more and cropped to it: official artwork, no second copy of
 * anything, and each hall badged with how many circles you have in it.
 *
 * Type is set small because the sheet is small - about a quarter of A4 for C108 -
 * and prints scaled up roughly 3.5x to fill the paper.
 */

import { PALETTE } from './layout.js';
import { write } from './pens.js';

const TYPE = { title: 6, sub: 3.4, legend: 3.7, hall: 3.9, badge: 4.4 };
const BADGE = 3.4;

export function drawSitePlan(page, { overview, rows, totals, title, subtitle,
                                     folio, fonts, rgb }) {
  const { box } = overview;
  for (const set of ['setMediaBox', 'setCropBox', 'setBleedBox', 'setTrimBox']) {
    page[set](box.x, box.y, box.w, box.h);
  }

  const found = new Map(rows.map(row => [row.hall, row]));
  for (const room of overview.halls) {
    const row = found.get(room.hall);
    if (row) drawBadge(page, room, row, fonts, rgb);
  }

  drawLegend(page, { overview, rows, totals, title, subtitle, folio, fonts, rgb });
}

/** A disc on the hall with the number of stops in it, in its top level's colour. */
function drawBadge(page, room, row, fonts, rgb) {
  const [r, g, b] = row.color.rgb;
  const [ir, ig, ib] = row.color.ink;
  const [x, y] = room.at;

  page.drawCircle({ x, y, size: BADGE, color: rgb(r, g, b),
                    borderColor: rgb(1, 1, 1), borderWidth: 0.6 });
  const label = String(row.count);
  const size = label.length > 2 ? TYPE.badge * 0.75 : TYPE.badge;
  write(page, label, x, y - size * 0.36,
        { size, fonts, bold: true, align: 'center', color: rgb(ir, ig, ib) });
}

/**
 * The written half of the sheet, in the corner of the plan the drawing leaves
 * blank: what day it is, what the colours mean, and which sheet each hall is on.
 */
function drawLegend(page, { overview, rows, totals, title, subtitle, folio,
                            fonts, rgb }) {
  const { free } = overview;
  const left = free.x + 3;
  const right = free.x + free.w - 2;
  const ink = rgb(0.07, 0.09, 0.12);
  const faint = rgb(0.45, 0.49, 0.54);
  let y = free.y + free.h - TYPE.title - 1;

  write(page, title, left, y, { size: TYPE.title, fonts, bold: true, color: ink });
  write(page, folio, right, y, { size: TYPE.sub, fonts, align: 'right', color: faint });
  y -= TYPE.sub + 2.2;
  write(page, subtitle, left, y, { size: TYPE.sub, fonts, color: faint });

  y -= 4;
  rule(page, left, right, y, rgb);

  y -= TYPE.legend + 1.6;
  PALETTE.forEach((level, i) => {
    const count = totals[i];
    const [r, g, b] = level.rgb;
    page.drawCircle({ x: left + 2, y: y + TYPE.legend * 0.33, size: 1.9,
                      color: rgb(r, g, b) });
    write(page, `${level.tag}  ${level.en}`, left + 6, y,
          { size: TYPE.legend, fonts, bold: true, color: ink });
    write(page, String(count), right, y,
          { size: TYPE.legend, fonts, align: 'right', color: count ? ink : faint });
    y -= TYPE.legend + 1.5;
  });

  y -= 1.2;
  rule(page, left, right, y, rgb);
  y -= TYPE.hall + 1.4;

  // two columns, so eight halls still fit in the corner
  const perColumn = Math.ceil(rows.length / 2) || 1;
  const columnW = (free.w - 6) / 2;
  rows.forEach((row, i) => {
    const cx = left + (i < perColumn ? 0 : columnW);
    const cy = y - (i % perColumn) * (TYPE.hall + 1.3);
    const [r, g, b] = row.color.rgb;
    page.drawRectangle({ x: cx, y: cy - 0.4, width: 1.5, height: TYPE.hall,
                         color: rgb(r, g, b) });
    write(page, row.name, cx + 3.4, cy, { size: TYPE.hall, fonts, color: ink });
    write(page, String(row.count), cx + columnW - 15, cy,
          { size: TYPE.hall, fonts, bold: true, align: 'right', color: ink });
    write(page, `p.${row.folio}`, cx + columnW - 4, cy,
          { size: TYPE.hall, fonts, align: 'right', color: faint });
  });

  if (!rows.length) {
    write(page, 'nothing placed on the map for this day', left, y,
          { size: TYPE.hall, fonts, color: faint });
  }
}

function rule(page, left, right, y, rgb) {
  page.drawLine({ start: { x: left, y }, end: { x: right, y },
                  thickness: 0.3, color: rgb(0.72, 0.76, 0.8) });
}
