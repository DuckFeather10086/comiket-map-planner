/**
 * PDF output: the official hall map with the wishlist stamped onto it.
 *
 * One file per day holds the whole map - all four sheets, whether or not you
 * marked anything on them - behind a cover sheet showing where the halls are.
 * Sheets come out of one copyPages() call so pdf-lib shares a single copy of the
 * artwork between them and keeps its original compressed streams; each sheet
 * then gets its own content array so markers do not bleed across sheets, and
 * both the per-hall zoom sheets and the cover are the same page again with its
 * boxes cropped.  Re-embedding a page per sheet instead would decompress the
 * artwork and inflate the file by about 45%.
 *
 * Markers are vector shapes over the printed cells.  The checklist is set with
 * a JIS X 0208 level-1 face, fetched only when one is actually printed.
 */

import { colorOf, PALETTE, topColor } from './layout.js';
import { cellRect, hallPanel, stripCellRect } from './mapdraw.js';
import { clip, measure, write } from './pens.js';
import { drawSitePlan } from './siteplan.js';

const A4 = { w: 595.28, h: 841.89 };

let libPromise;

function loadLibs() {
  libPromise ??= (async () => {
    await Promise.all([
      inject(new URL('../vendor/pdf-lib.min.js', import.meta.url).href),
      inject(new URL('../vendor/fontkit.umd.min.js', import.meta.url).href),
    ]);
    return { lib: window.PDFLib, fontkit: window.fontkit };
  })();
  return libPromise;
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

let jisPromise;

/**
 * The checklist sets arbitrary circle names, so it needs real Japanese
 * coverage: JIS X 0208 level 1, which is what ordinary Japanese text uses.
 *
 * It goes in whole rather than subset because pdf-lib's TrueType subsetter
 * silently drops glyphs from CJK fonts past about 30 kB - the text layer comes
 * out right and the page renders blank - so it costs roughly 300 kB, and is
 * fetched only when a checklist is printed.
 */
function loadJisFont() {
  jisPromise ??= fetch(new URL('../vendor/jis-level1.ttf', import.meta.url))
    .then(r => r.arrayBuffer());
  return jisPromise;
}

const DAY_LABEL = {
  1: { jp: '1日目', date: '2026-08-15 Sat' },
  2: { jp: '2日目', date: '2026-08-16 Sun' },
};

const ROMAJI = { 東: 'East', 西: 'West', 南: 'South' };
const romanise = hall => hall.replace(/[東西南]/g, m => ROMAJI[m] + ' ').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ planning */

/** Where a resolved code sits on its page, in map points. */
export function markerRect(layout, r) {
  if (!r.ok) return null;
  if (r.wall) return stripCellRect(r.strip, r.number);
  return cellRect(layout.blocks.get(r.block), r.number);
}

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
    rect: markerRect(layout, m.r),
    code: m.r.ok ? m.r.canonical : `${m.r.hall}${m.r.block}-${m.r.number}${m.r.sub}`,
  }));
}

function sortKey(layout, m) {
  if (!m.r.ok) return [m.r.page ?? 9, 99, 9e9, m.r.number ?? 9e9];
  const page = layout.page(m.r.page);
  const hall = page.halls.indexOf(m.r.hall);
  // walls first within a hall: that is the queue you join before the islands
  if (m.r.wall) return [m.r.page, hall, -1, m.r.number];
  return [m.r.page, hall, m.r.rect.block.x, m.r.number];
}

/* -------------------------------------------------------------------- output */

export async function buildPdf({ mapBytes, layout, store, days, options }) {
  const { lib, fontkit } = await loadLibs();
  const { PDFDocument, StandardFonts, rgb, degrees,
          PDFArray, PDFRef, PDFName } = lib;
  const source = await PDFDocument.load(mapBytes);

  const jobs = options.splitDays
    ? days.map(day => ({ days: [day], suffix: DAY_LABEL[day].jp }))
    : [{ days, suffix: days.length > 1 ? '全日程' : DAY_LABEL[days[0]].jp }];

  const outputs = [];
  for (const job of jobs) {
    const plans = job.days
      .map(day => ({ day, entries: store.forDay(day) }))
      .filter(p => p.entries.length)
      .map(p => ({ ...p, markers: planMarkers(layout, p.entries) }));
    if (!plans.length) continue;

    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    out.setTitle(`${layout.event} 巡回地図`);
    out.setCreator('comiket-map-planner');
    const fonts = {
      latin: await out.embedFont(StandardFonts.Helvetica),
      bold: await out.embedFont(StandardFonts.HelveticaBold),
    };

    // every sheet planned up front, in the order it will be bound: the folio
    // numbers the cover sheet points with have to be known before anything is
    // drawn, and pdf-lib caches copied objects per copyPages call, so one call
    // keeps a single copy of the artwork for the whole document
    const sheets = plans.flatMap(plan => planSheets(layout, plan, options));
    sheets.forEach((sheet, i) => Object.assign(sheet, { folio: i + 1,
                                                       total: sheets.length }));

    const copied = await out.copyPages(
      source, sheets.filter(s => s.kind !== 'list').map(s => s.pageIndex));

    let cursor = 0;
    for (const sheet of sheets) {
      if (sheet.kind === 'list') {
        fonts.jp ??= await out.embedFont(await loadJisFont(), { subset: false });
        paintChecklist(out, sheet, fonts, rgb);
        continue;
      }
      const page = copied[cursor++];
      out.addPage(page);
      isolateContents(out, page, { PDFArray, PDFRef, PDFName });
      if (sheet.kind === 'cover') {
        drawCover({ layout, page, sheet, sheets, fonts, rgb });
      } else {
        drawSheet({ layout, page, sheet, fonts, rgb, degrees });
      }
    }

    outputs.push({
      name: `${layout.event}_${job.suffix}_巡回地図.pdf`,
      bytes: await out.save(),
    });
  }
  return outputs;
}

/**
 * One day's sheets, in order: the site plan, then the whole official map - every
 * sheet of it, so the file is the map and not just the pages you happened to
 * mark - each followed by a cropped sheet per hall you have stops in, and the
 * walking list last.
 */
function planSheets(layout, plan, options) {
  const byPage = new Map();
  for (const m of plan.markers) {
    if (!m.placed) continue;
    if (!byPage.has(m.page)) byPage.set(m.page, []);
    byPage.get(m.page).push(m);
  }

  const sheets = [];
  if (options.sitePlan && layout.overview) {
    sheets.push({ plan, kind: 'cover', pageIndex: layout.overview.page });
  }
  layout.pages.forEach((meta, pageIndex) => {
    const markers = byPage.get(pageIndex) || [];
    sheets.push({ plan, kind: 'map', pageIndex, markers });
    if (!options.zoomPages) return;
    for (const hall of meta.halls) {
      if (!markers.some(m => m.hall === hall)) continue;
      const panel = hallPanel(layout, pageIndex, hall);
      if (panel) sheets.push({ plan, kind: 'zoom', pageIndex, markers, hall, panel });
    }
  });
  if (options.checklist) {
    const placed = new Set(plan.markers.map(m => m.entry.id));
    const unplaced = plan.entries.filter(e => !placed.has(e.id));
    for (const rows of checklistPages(plan.markers, unplaced)) {
      sheets.push({ plan, kind: 'list', rows });
    }
  }
  return sheets;
}

/** Which folio a hall's map sheet ended up on, for the cover sheet to point at. */
function folioOf(sheets, plan, pageIndex) {
  const sheet = sheets.find(s => s.plan === plan && s.kind === 'map'
                                 && s.pageIndex === pageIndex);
  return sheet ? sheet.folio : 1;
}

function drawCover({ layout, page, sheet, sheets, fonts, rgb }) {
  const { plan } = sheet;
  const placed = plan.markers.filter(m => m.placed);
  const rows = [];
  for (const [pageIndex, meta] of layout.pages.entries()) {
    for (const hall of meta.halls) {
      const here = placed.filter(m => m.hall === hall);
      if (!here.length) continue;
      rows.push({
        hall, name: romanise(hall), count: here.length,
        color: topColor(here.map(m => m.entry)),
        folio: folioOf(sheets, plan, pageIndex),
      });
    }
  }

  const lost = plan.entries.length - placed.length;
  drawSitePlan(page, {
    overview: layout.overview,
    rows,
    totals: PALETTE.map(level =>
      plan.entries.filter(e => colorOf(e.color) === level).length),
    title: `DAY ${plan.day} - ${DAY_LABEL[plan.day].date}`,
    subtitle: `${layout.event} VENUE PLAN - ${plural(plan.entries.length, 'stop')}`
              + (lost ? ` - ${lost} not on the map, see the list` : ''),
    folio: `${sheet.folio} / ${sheet.total}`,
    fonts, rgb,
  });
}

/**
 * Give a copied page its own /Contents array.
 *
 * copyPages hands every copy of one source page the same array instance, so
 * without this a marker drawn on one sheet appears on all of them.  The content
 * streams stay shared - only the list is new - so it costs nothing.
 */
function isolateContents(out, page, { PDFArray, PDFRef, PDFName }) {
  const key = PDFName.of('Contents');
  const raw = page.node.get(key);
  let refs;
  if (raw instanceof PDFArray) {
    refs = raw.asArray().slice();
  } else if (raw instanceof PDFRef) {
    const target = out.context.lookup(raw);
    refs = target instanceof PDFArray ? target.asArray().slice() : [raw];
  } else {
    return;
  }
  const fresh = PDFArray.withContext(out.context);
  for (const ref of refs) fresh.push(ref);
  page.node.set(key, fresh);
}

function drawSheet({ layout, page, sheet, fonts, rgb, degrees }) {
  const mine = sheet.hall
    ? sheet.markers.filter(m => m.hall === sheet.hall)
    : sheet.markers;
  for (const marker of mine) drawMarker(page, marker, fonts.bold, rgb, degrees);

  const meta = layout.page(sheet.pageIndex);
  let left = 0, top = meta.height, width = meta.width;
  if (sheet.hall) {
    const { box } = sheet.panel;
    const h = box.h + sheet.panel.header;
    for (const set of ['setMediaBox', 'setCropBox', 'setBleedBox', 'setTrimBox']) {
      page[set](box.x, box.y, box.w, h);
    }
    [left, top, width] = [box.x, box.y + h, box.w];
  }

  const where = sheet.hall
    ? romanise(sheet.hall)
    : meta.halls.map(romanise).join(' / ');
  const count = mine.length ? plural(mine.length, 'stop') : 'nothing marked';
  stamp(page, fonts, rgb, [
    `DAY ${sheet.plan.day} - ${DAY_LABEL[sheet.plan.day].date}`,
    where, count, `${sheet.folio} / ${sheet.total}`,
  ].join('  -  '), left, top, width, mine.length > 0);
}

/**
 * The caption strip: which day and hall a sheet is, and what its colours mean.
 *
 * It goes over the printed artwork in an opaque box, at the top left, where the
 * map has its own hall label - the zoom sheets crop in a header strip for it.
 * The key is dropped rather than crowded when a narrow sheet has no room.
 */
function stamp(page, fonts, rgb, text, left, top, width, key) {
  const size = 9;
  const textW = measure(text, size, fonts, true);
  const keyW = key ? PALETTE.reduce(
    (w, level) => w + 13 + measure(`${level.tag} ${level.en}`, 7, fonts, true), 8) : 0;
  const fits = keyW && textW + keyW + 40 <= width;
  page.drawRectangle({
    x: left + 12, y: top - 26, width: textW + (fits ? keyW : 0) + 14, height: 16,
    color: rgb(1, 1, 1), opacity: 0.9,
    borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.6,
  });
  write(page, text, left + 19, top - 22,
        { size, fonts, bold: true, color: rgb(0.1, 0.1, 0.1) });
  if (!fits) return;

  let x = left + 19 + textW + 8;
  for (const level of PALETTE) {
    const [r, g, b] = level.rgb;
    page.drawCircle({ x: x + 3, y: top - 18.4, size: 3, color: rgb(r, g, b) });
    write(page, `${level.tag} ${level.en}`, x + 8, top - 21,
          { size: 7, fonts, bold: true, color: rgb(0.2, 0.23, 0.27) });
    x += 13 + measure(`${level.tag} ${level.en}`, 7, fonts, true);
  }
}

/**
 * Highlight one space and put its walking number in the aisle beside it, so the
 * printed space number underneath stays readable.
 */
function drawMarker(page, marker, font, rgb, degrees) {
  const { rect } = marker;
  if (!rect) return;
  const [r, g, b] = colorOf(marker.color).rgb;
  const colour = rgb(r, g, b);

  page.drawRectangle({
    x: rect.x, y: rect.y, width: rect.w, height: rect.h,
    color: colour, opacity: 0.42,
    borderColor: colour, borderWidth: 0.9,
    ...(rect.a ? { rotate: degrees(rect.a) } : null),
  });

  // the badge sits beside the cell, along whichever way the cell is turned
  const rad = (rect.a || 0) * Math.PI / 180;
  const out = rect.w + 4.6, up = rect.h / 2;
  const badgeX = rect.x + out * Math.cos(rad) - up * Math.sin(rad);
  const badgeY = rect.y + out * Math.sin(rad) + up * Math.cos(rad);
  page.drawCircle({ x: badgeX, y: badgeY, size: 4.4, color: colour,
                    borderColor: rgb(1, 1, 1), borderWidth: 0.7 });
  const label = String(marker.index);
  const size = label.length > 2 ? 4.4 : 5.4;
  page.drawText(label, {
    x: badgeX - font.widthOfTextAtSize(label, size) / 2,
    y: badgeY - size * 0.36,
    size, font, color: rgb(1, 1, 1),
  });
}

/* ---------------------------------------------------------------- checklist */

const CHECK = { margin: 34, rowH: 22, headH: 48, groupH: 20 };

/**
 * The walking list, grouped by hall and cut into sheets.
 *
 * It comes out before anything is drawn so the sheets can be counted with the
 * rest, which is what lets the cover sheet print folio numbers.
 */
function checklistPages(markers, unplaced) {
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
  return groups.length ? paginate(groups) : [];
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

/** One list sheet: a title, the colour key, then hall by hall. */
function paintChecklist(doc, sheet, fonts, rgb) {
  const { plan, rows: groups } = sheet;
  const day = plan.day;
  const page = doc.addPage([A4.w, A4.h]);
  const left = CHECK.margin;
  const right = A4.w - CHECK.margin;
  let y = A4.h - CHECK.margin;

  write(page, `${DAY_LABEL[day].jp}  ${DAY_LABEL[day].date}  巡回リスト`,
        left, y - 13, { size: 14, fonts, bold: true, color: rgb(0.07, 0.09, 0.12) });
  write(page, `${sheet.folio} / ${sheet.total}`, right, y - 12,
        { size: 9, fonts, align: 'right', color: rgb(0.5, 0.54, 0.58) });

  let keyX = left;
  for (const level of PALETTE) {
    const [r, g, b] = level.rgb;
    page.drawCircle({ x: keyX + 3.5, y: y - 27, size: 3.5, color: rgb(r, g, b) });
    write(page, `${level.tag} ${level.en}`, keyX + 9.5, y - 29.5,
          { size: 7.5, fonts, bold: true, color: rgb(0.35, 0.39, 0.44) });
    keyX += 22 + measure(`${level.tag} ${level.en}`, 7.5, fonts, true);
  }
  y -= CHECK.headH;

  const colCode = left + 26;
  const colName = left + 96;
  const colTag = right - 52;
  const colCheck = right - 16;

  for (const group of groups) {
    page.drawRectangle({ x: left, y: y - CHECK.groupH + 6, width: right - left,
                         height: CHECK.groupH - 6, color: rgb(0.94, 0.95, 0.96) });
    write(page, group.hall, left + 6, y - CHECK.groupH + 11,
          { size: 9, fonts, bold: true, color: rgb(0.2, 0.23, 0.27) });
    y -= CHECK.groupH;

    for (const row of group.rows) {
      const level = colorOf(row.color);
      const [r, g, b] = level.rgb;
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

      // the level in words as well as in colour, so a photocopy still reads
      const [ir, ig, ib] = level.ink;
      page.drawRectangle({ x: colTag, y: mid - 4.5, width: 16, height: 9,
                           color: colour, borderColor: colour, borderWidth: 0.5 });
      write(page, level.tag, colTag + 8, mid - 2.2,
            { size: 6.5, fonts, bold: true, align: 'center', color: rgb(ir, ig, ib) });

      const width = colTag - colName - 10;
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
