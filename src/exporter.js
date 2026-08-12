/**
 * PDF output: the map is drawn, not borrowed.
 *
 * Every sheet comes out of the same `mapdraw` routine that paints the screen, so
 * what you print is what you saw.  Sheets are all vector: the space grid and
 * markers as shapes, kana block letters and hall names through a 9 kB font
 * subset holding only those glyphs, everything ASCII through the built-in
 * Helvetica.  The checklist needs arbitrary Japanese for circle names, so it
 * pulls in a JIS X 0208 level-1 face, but only when a checklist is printed.
 */

import { colorOf } from './layout.js';
import { allPanels, drawPanel, markKey } from './mapdraw.js';
import { PdfPen, fit, splitRuns } from './pens.js';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 22;

let libPromise;

function loadLibs() {
  libPromise ??= (async () => {
    await Promise.all([
      inject(new URL('../vendor/pdf-lib.min.js', import.meta.url).href),
      inject(new URL('../vendor/fontkit.umd.min.js', import.meta.url).href),
    ]);
    const font = await fetch(new URL('../vendor/kana-subset.ttf', import.meta.url))
      .then(r => r.arrayBuffer());
    return { lib: window.PDFLib, fontkit: window.fontkit, cjkFont: font };
  })();
  return libPromise;
}

let jisPromise;

/**
 * The checklist sets arbitrary circle names, so it needs real Japanese
 * coverage: JIS X 0208 level 1, which is what ordinary Japanese text uses.
 * Fetched only when a checklist is actually being printed.
 *
 * It goes in whole rather than subset because pdf-lib's TrueType subsetter
 * silently drops glyphs from CJK fonts past about 30 kB - the text layer comes
 * out right and the page renders blank - so the font is embedded as-is and
 * costs roughly 300 kB in the output.
 */
function loadJisFont() {
  jisPromise ??= fetch(new URL('../vendor/jis-level1.ttf', import.meta.url))
    .then(r => r.arrayBuffer());
  return jisPromise;
}

function inject(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(el);
  });
}

const DAY_LABEL = {
  1: { jp: '1日目', date: '2026-08-15 Sat' },
  2: { jp: '2日目', date: '2026-08-16 Sun' },
};

/* ------------------------------------------------------------------ planning */

/** Markers for one day, numbered in walking order. */
export function planMarkers(layout, entries) {
  const found = entries
    .map(entry => ({ entry, r: layout.resolve(entry.code) }))
    .filter(m => m.r.ok || m.r.reason === 'wall');

  found.sort((a, b) => {
    const ka = sortKey(layout, a), kb = sortKey(layout, b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });

  return found.map((m, i) => ({
    index: i + 1,
    entry: m.entry,
    color: m.entry.color,
    page: m.r.page,
    hall: m.r.hall,
    block: m.r.block,
    number: m.r.number,
    placed: m.r.ok,
    code: m.r.ok ? m.r.canonical : `${m.r.hall}${m.r.block}-${m.r.number}${m.r.sub}`,
  }));
}

function sortKey(layout, m) {
  if (!m.r.ok) return [m.r.page ?? 9, 99, 9e9, m.r.number ?? 9e9];
  const page = layout.page(m.r.page);
  const hall = page.halls.indexOf(m.r.hall);
  // walls first within a hall: that is the queue you join before working the
  // islands, and it keeps the numbering in walking order
  if (m.r.wall) return [m.r.page, hall, -1, m.r.number];
  return [m.r.page, hall, m.r.rect.block.x, m.r.number];
}

/** Group a day's markers by the panel they belong to. */
export function groupByPanel(layout, markers) {
  const panels = allPanels(layout);
  const byHall = new Map();
  for (const m of markers) {
    const key = `${m.page}/${m.hall}`;
    if (!byHall.has(key)) byHall.set(key, []);
    byHall.get(key).push(m);
  }
  const out = [];
  for (const panel of panels) {
    const placed = byHall.get(`${panel.pageIndex}/${panel.hall}`) || [];
    // a wall block runs around all the halls on its page, so its note goes on
    // each of that page's sheets rather than one named hall
    const notes = markers.filter(m => !m.placed && m.page === panel.pageIndex);
    if (placed.length || notes.length) out.push({ panel, markers: placed, notes });
  }
  const orphans = markers.filter(
    m => !m.placed && !panels.some(p => p.pageIndex === m.page));
  return { sheets: out, orphans };
}

/* -------------------------------------------------------------------- output */

export async function buildPdf({ layout, store, days, options }) {
  const { lib, fontkit, cjkFont } = await loadLibs();
  const { PDFDocument, StandardFonts, rgb } = lib;

  const jobs = options.splitDays
    ? days.map(day => ({ days: [day], suffix: DAY_LABEL[day].jp }))
    : [{ days, suffix: days.length > 1 ? '全日程' : DAY_LABEL[days[0]].jp }];

  const outputs = [];
  for (const job of jobs) {
    const plans = job.days
      .map(day => ({ day, entries: store.forDay(day) }))
      .filter(p => p.entries.length);
    if (!plans.length) continue;

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setTitle(`${layout.event} 巡回地図`);
    doc.setCreator('comiket-map-planner');
    const fonts = {
      latin: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      cjk: await doc.embedFont(cjkFont, { subset: false }),
    };

    for (const plan of plans) {
      const markers = planMarkers(layout, plan.entries);
      const { sheets, orphans } = groupByPanel(layout, markers);

      for (const sheet of sheets) {
        drawSheet({ doc, rgb, fonts, sheet, day: plan.day, layout });
      }
      if (options.checklist) {
        fonts.jp ??= await doc.embedFont(await loadJisFont(), { subset: false });
        const placed = new Set(markers.map(m => m.entry.id));
        await addChecklist(doc, plan.day, markers,
                           plan.entries.filter(e => !placed.has(e.id)), fonts, rgb);
      }
    }

    outputs.push({
      name: `${layout.event}_${job.suffix}_巡回地図.pdf`,
      bytes: await doc.save(),
    });
  }
  return outputs;
}

function drawSheet({ doc, rgb, fonts, sheet, day }) {
  const { panel } = sheet;
  const box = {
    x: panel.box.x, y: panel.box.y,
    w: panel.box.w, h: panel.box.h + panel.header,
  };
  // portrait or landscape, whichever blows the hall up more
  const landscape = box.w / box.h >= 1;
  const size = landscape ? [A4.h, A4.w] : [A4.w, A4.h];
  const page = doc.addPage(size);

  const target = {
    x: MARGIN, y: MARGIN,
    w: size[0] - MARGIN * 2, h: size[1] - MARGIN * 2 - 14,
  };
  const pen = new PdfPen(page, fit(box, target), fonts, rgb);

  const marks = new Map();
  for (const m of sheet.markers) {
    marks.set(markKey(m.block, m.number), { index: m.index, color: m.color });
  }
  drawPanel(pen, panel, marks, { notes: sheet.notes });

  const header = `DAY ${day} - ${DAY_LABEL[day].date}`;
  page.drawText(header, {
    x: MARGIN, y: size[1] - MARGIN + 2, size: 8,
    font: fonts.bold, color: rgb(0.45, 0.48, 0.52),
  });
}

/* ---------------------------------------------------------------- checklist */

const CHECK = { margin: 34, rowH: 22, headH: 36, groupH: 20 };

/** The walking list, set as real text so it can be searched and selected. */
async function addChecklist(doc, day, markers, unplaced, fonts, rgb) {
  const groups = [];
  for (const m of markers) {
    const hall = m.placed ? m.hall : `${m.hall}（地図に印なし）`;
    const last = groups.at(-1);
    if (last && last.hall === hall) last.rows.push(m);
    else groups.push({ hall, rows: [m] });
  }
  const extra = unplaced.filter(e => !markers.some(m => m.entry.id === e.id));
  if (extra.length) {
    groups.push({
      hall: '未定位（配置を読めませんでした）',
      rows: extra.map(entry => ({ index: null, entry, code: entry.code,
                                  color: entry.color })),
    });
  }
  if (!groups.length) return;

  const sheets = paginate(groups);
  sheets.forEach((rows, i) =>
    paintChecklist(doc, rows, day, i + 1, sheets.length, fonts, rgb));
}

function paginate(groups) {
  const usable = A4.h - CHECK.margin * 2 - CHECK.headH;
  const pages = [[]];
  let used = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      const target = pages.at(-1);
      const tail = target.at(-1);
      const fresh = !tail || tail.hall !== group.hall;
      if (used + CHECK.rowH + (fresh ? CHECK.groupH : 0) > usable) {
        pages.push([{ hall: group.hall, rows: [row] }]);
        used = CHECK.groupH + CHECK.rowH;
      } else if (fresh) {
        target.push({ hall: group.hall, rows: [row] });
        used += CHECK.groupH + CHECK.rowH;
      } else {
        tail.rows.push(row);
        used += CHECK.rowH;
      }
    }
  }
  return pages;
}

/**
 * The Japanese face is a CJK fallback and carries no Latin, so every string is
 * split by script and each run drawn with the font that actually has it.
 */
function pickFont(run, fonts, bold) {
  return run.cjk ? fonts.jp : (bold ? fonts.bold : fonts.latin);
}

function measure(text, size, fonts, bold = false) {
  return splitRuns(text).reduce(
    (w, run) => w + pickFont(run, fonts, bold).widthOfTextAtSize(run.text, size), 0);
}

function write(page, text, x, y, { size, fonts, bold = false, color, align }) {
  let px = x;
  if (align === 'right') px -= measure(text, size, fonts, bold);
  for (const run of splitRuns(text)) {
    const font = pickFont(run, fonts, bold);
    page.drawText(run.text, { x: px, y, size, font, color });
    px += font.widthOfTextAtSize(run.text, size);
  }
}

function clip(text, size, fonts, maxWidth) {
  if (measure(text, size, fonts) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measure(out + '…', size, fonts) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '…';
}

function paintChecklist(doc, groups, day, pageNo, pageTotal, fonts, rgb) {
  const page = doc.addPage([A4.w, A4.h]);
  const left = CHECK.margin;
  const right = A4.w - CHECK.margin;
  let y = A4.h - CHECK.margin;

  write(page, `${DAY_LABEL[day].jp}  ${DAY_LABEL[day].date}  巡回リスト`,
        left, y - 13, { size: 14, fonts, bold: true, color: rgb(0.07, 0.09, 0.12) });
  write(page, `${pageNo} / ${pageTotal}`, right, y - 12,
        { size: 9, fonts, align: 'right', color: rgb(0.5, 0.54, 0.58) });
  y -= CHECK.headH;

  const colCode = left + 26;
  const colName = left + 96;
  const colCheck = right - 16;

  for (const group of groups) {
    page.drawRectangle({ x: left, y: y - CHECK.groupH + 6, width: right - left,
                         height: CHECK.groupH - 6, color: rgb(0.94, 0.95, 0.96) });
    write(page, group.hall, left + 6, y - CHECK.groupH + 11,
          { size: 9, fonts, bold: true, color: rgb(0.2, 0.23, 0.27) });
    y -= CHECK.groupH;

    for (const row of group.rows) {
      const [r, g, b] = colorOf(row.color).rgb;
      const colour = rgb(r, g, b);
      const mid = y - 11;

      if (row.index === null) {
        page.drawCircle({ x: left + 8, y: mid, size: 6.5,
                          borderColor: colour, borderWidth: 1.2 });
      } else {
        page.drawCircle({ x: left + 8, y: mid, size: 6.5, color: colour });
        const label = String(row.index);
        page.drawText(label, {
          x: left + 8 - fonts.bold.widthOfTextAtSize(label, 7) / 2, y: mid - 2.5,
          size: 7, font: fonts.bold, color: rgb(1, 1, 1),
        });
      }

      write(page, row.code, colCode, mid - 3,
            { size: 9.5, fonts, bold: true, color: rgb(0.07, 0.09, 0.12) });

      const width = colCheck - colName - 22;
      if (row.entry.name) {
        write(page, clip(row.entry.name, 9, fonts, width),
              colName, mid + (row.entry.note ? 1 : -3),
              { size: 9, fonts, color: rgb(0.13, 0.15, 0.18) });
      }
      if (row.entry.note) {
        write(page, clip(row.entry.note, 7.5, fonts, width), colName, mid - 7,
              { size: 7.5, fonts, color: rgb(0.53, 0.56, 0.6) });
      }

      page.drawRectangle({ x: colCheck - 5, y: mid - 5, width: 10, height: 10,
                           borderColor: rgb(0.6, 0.63, 0.67), borderWidth: 0.8 });

      y -= CHECK.rowH;
      page.drawLine({ start: { x: left, y: y + 2 }, end: { x: right, y: y + 2 },
                      thickness: 0.4, color: rgb(0.91, 0.93, 0.95) });
    }
  }
}
