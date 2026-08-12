/**
 * PDF output: the official map with the wishlist stamped onto it.
 *
 * Everything stays vector.  Map sheets are produced with a single copyPages()
 * call so pdf-lib shares one copy of the artwork between them and keeps the
 * original compressed streams; each sheet then gets its own content array so
 * markers do not bleed across sheets, and a per-hall zoom sheet is just another
 * copy with its page boxes cropped to that hall.  Re-embedding the page per
 * sheet instead would decompress the artwork and inflate the file by ~45%.
 *
 * The one raster part is the checklist, painted on a canvas and embedded as an
 * image: that avoids shipping a multi-megabyte CJK font to set circle names,
 * and costs about 40 kB a page.
 */

import { colorOf } from './layout.js';

const A4 = { w: 595.28, h: 841.89 };

let pdfLibPromise;

function loadPdfLib() {
  pdfLibPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/pdf-lib.min.js', import.meta.url).href;
    script.onload = () => resolve(window.PDFLib);
    script.onerror = () => reject(new Error('pdf-lib-load-failed'));
    document.head.append(script);
  });
  return pdfLibPromise;
}

const DAY_LABEL = {
  1: { zh: '1日目', date: '2026-08-15 Sat' },
  2: { zh: '2日目', date: '2026-08-16 Sun' },
};

const ROMAJI = { 東: 'East', 西: 'West', 南: 'South' };
const romanise = hall => hall.replace(/[東西南]/g, m => ROMAJI[m] + ' ').trim();

/* ------------------------------------------------------------------ planning */

/** Markers for one day, numbered in walking order. */
export function planMarkers(layout, entries) {
  const found = entries
    .map(entry => ({ entry, r: layout.resolve(entry.code), pin: entry.pin }))
    .filter(m => m.r.ok || m.pin);

  found.sort((a, b) => {
    const ka = sortKey(layout, a), kb = sortKey(layout, b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });

  // a hand-placed pin wins over the resolved cell: it is the user correcting us
  return found.map((m, i) => ({
    index: i + 1,
    entry: m.entry,
    rgb: colorOf(m.entry.color).rgb,
    page: m.pin ? m.pin.page : m.r.page,
    hall: m.r.hall || '—',
    rect: m.pin ? null : m.r.rect,
    point: m.pin ? { x: m.pin.x, y: m.pin.y } : null,
    code: m.r.ok ? m.r.canonical : m.entry.code,
  }));
}

function sortKey(layout, m) {
  // wall blocks and hand-pinned entries have no grid position; sort them after
  // the placed ones on their page so the numbering still runs front to back
  if (!m.r.ok) return [m.pin ? m.pin.page : 9, 9, 9e9, m.r.number ?? 9e9];
  const page = layout.page(m.r.page);
  return [m.r.page, page.halls.indexOf(m.r.hall), m.r.rect.block.x, m.r.number];
}

/** Sheets to produce for one day, in printing order. */
function planDay(layout, store, day, options) {
  const entries = store.forDay(day);
  if (!entries.length) return null;

  const markers = planMarkers(layout, entries);
  const placed = new Set(markers.map(m => m.entry.id));
  // wall blocks and codes we could not read still belong on the checklist,
  // otherwise the printed plan silently loses part of the wishlist
  const unplaced = entries.filter(e => !placed.has(e.id));

  const byPage = new Map();
  for (const marker of markers) {
    if (!byPage.has(marker.page)) byPage.set(marker.page, []);
    byPage.get(marker.page).push(marker);
  }

  const sheets = [];
  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageMarkers = byPage.get(pageIndex);
    sheets.push({ pageIndex, hall: null, day, markers: pageMarkers });
    if (!options.zoomPages) continue;
    for (const hall of new Set(pageMarkers.map(m => m.hall))) {
      const box = layout.hallBox(pageIndex, hall);
      if (box) sheets.push({ pageIndex, hall, day, markers: pageMarkers, box });
    }
  }
  return { day, sheets, markers, unplaced };
}

/* -------------------------------------------------------------------- output */

/**
 * Build the annotated PDF(s).
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function buildPdf({ mapBytes, layout, store, days, options }) {
  const lib = await loadPdfLib();
  const { PDFDocument } = lib;
  const source = await PDFDocument.load(mapBytes);

  const jobs = options.splitDays
    ? days.map(day => ({ days: [day], suffix: DAY_LABEL[day].zh }))
    : [{ days, suffix: days.length > 1 ? '全日程' : DAY_LABEL[days[0]].zh }];

  const outputs = [];
  for (const job of jobs) {
    const plans = job.days.map(day => planDay(layout, store, day, options)).filter(Boolean);
    if (!plans.length) continue;

    const bytes = await renderDocument({ lib, source, layout, plans, options });
    outputs.push({ name: `${layout.event}_${job.suffix}_巡回地図.pdf`, bytes });
  }
  return outputs;
}

async function renderDocument({ lib, source, layout, plans, options }) {
  const { PDFDocument, rgb, StandardFonts } = lib;
  const out = await PDFDocument.create();
  out.setTitle(`${layout.event} 巡回地図`);
  out.setCreator('comiket-map-planner');
  const font = await out.embedFont(StandardFonts.HelveticaBold);

  // one copyPages call for every sheet in the document: pdf-lib caches copied
  // objects per call, so separate calls would duplicate the whole map
  const sheets = plans.flatMap(plan => plan.sheets);
  const copied = sheets.length
    ? await out.copyPages(source, sheets.map(s => s.pageIndex))
    : [];

  let cursor = 0;
  for (const plan of plans) {
    for (const sheet of plan.sheets) {
      const page = copied[cursor++];
      out.addPage(page);
      isolateContents(out, page, lib);

      for (const marker of sheet.markers) {
        drawMarker(page, marker, font, rgb);
      }

      if (sheet.box) {
        const { left, bottom, right, top } = sheet.box;
        const w = right - left, h = top - bottom;
        page.setMediaBox(left, bottom, w, h);
        page.setCropBox(left, bottom, w, h);
        page.setBleedBox(left, bottom, w, h);
        page.setTrimBox(left, bottom, w, h);
        stampHeader(page, font, rgb,
          `DAY ${sheet.day} - ${romanise(sheet.hall)}`, left, top);
      } else {
        const meta = layout.page(sheet.pageIndex);
        stampHeader(page, font, rgb,
          `DAY ${sheet.day} - ${DAY_LABEL[sheet.day].date} - ` +
          meta.halls.map(romanise).join(' / '), 0, meta.height);
      }
    }

    if (options.checklist) {
      await addChecklist(out, plan.day, plan.markers, plan.unplaced);
    }
  }
  return out.save();
}

/**
 * Give a copied page its own /Contents array.
 *
 * copyPages hands every copy of the same source page the identical array
 * instance, so without this a marker drawn on one sheet appears on all of them.
 * The content streams themselves stay shared - only the list is new - so this
 * costs nothing.
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

function stampHeader(page, font, rgb, text, left, top) {
  const size = 9;
  const width = font.widthOfTextAtSize(text, size);
  page.drawRectangle({
    x: left + 12, y: top - 26, width: width + 14, height: 16,
    color: rgb(1, 1, 1), opacity: 0.9,
    borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.6,
  });
  page.drawText(text, {
    x: left + 19, y: top - 22, size, font, color: rgb(0.1, 0.1, 0.1),
  });
}

/**
 * Highlight one space and put its walking number in the aisle beside it, so the
 * printed space number underneath stays readable.
 */
function drawMarker(page, marker, font, rgb) {
  const [r, g, b] = marker.rgb;
  const colour = rgb(r, g, b);

  let badgeX, badgeY;
  if (marker.rect) {
    const { x0, y0, x1, y1, block } = marker.rect;
    page.drawRectangle({
      x: x0, y: y0, width: x1 - x0, height: y1 - y0,
      color: colour, opacity: 0.42, borderColor: colour, borderWidth: 0.9,
    });
    const rightHalf = x0 > block.x + block.w / 4;
    badgeX = (rightHalf ? x1 : x0) + (rightHalf ? 1 : -1) * 4.6;
    badgeY = (y0 + y1) / 2;
  } else {
    const { x, y } = marker.point;
    page.drawLine({
      start: { x, y }, end: { x, y: y + 11 }, thickness: 1.2, color: colour,
    });
    badgeX = x;
    badgeY = y + 15;
  }

  page.drawCircle({
    x: badgeX, y: badgeY, size: 4.4,
    color: colour, borderColor: rgb(1, 1, 1), borderWidth: 0.7,
  });
  const label = String(marker.index);
  const size = label.length > 2 ? 4.4 : 5.4;
  page.drawText(label, {
    x: badgeX - font.widthOfTextAtSize(label, size) / 2,
    y: badgeY - size * 0.36,
    size, font, color: rgb(1, 1, 1),
  });
}

/* ---------------------------------------------------------------- checklist */

const CHECK = {
  dpi: 2.6,                 // canvas pixels per PDF point
  margin: 34,
  rowH: 22,
  headH: 34,
  groupH: 22,
};

async function addChecklist(out, day, markers, unplaced = []) {
  const groups = [];
  for (const marker of markers) {
    const last = groups.at(-1);
    if (last && last.hall === marker.hall) last.rows.push(marker);
    else groups.push({ hall: marker.hall, rows: [marker] });
  }
  if (unplaced.length) {
    groups.push({
      hall: '未定位（地図に印なし・現地確認）',
      rows: unplaced.map(entry => ({
        index: null, entry, code: entry.code, rgb: colorOf(entry.color).rgb,
      })),
    });
  }
  if (!groups.length) return;

  const pages = paginate(groups);
  for (const [i, page] of pages.entries()) {
    const canvas = paintChecklist(page, day, i + 1, pages.length);
    const png = await out.embedPng(canvas.toDataURL('image/png'));
    out.addPage([A4.w, A4.h])
      .drawImage(png, { x: 0, y: 0, width: A4.w, height: A4.h });
  }
}

/** Split hall groups across A4 sheets, repeating a hall heading when it spans. */
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
        continue;
      }
      if (fresh) {
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

function paintChecklist(groups, day, pageNo, pageTotal) {
  const k = CHECK.dpi;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(A4.w * k);
  canvas.height = Math.round(A4.h * k);
  const ctx = canvas.getContext('2d');
  const font = (size, weight = 400) =>
    `${weight} ${size * k}px system-ui, "Hiragino Sans", "Noto Sans JP", "Noto Sans SC", sans-serif`;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const left = CHECK.margin * k;
  const right = (A4.w - CHECK.margin) * k;
  let y = CHECK.margin * k;

  ctx.fillStyle = '#111';
  ctx.font = font(15, 700);
  ctx.fillText(`${DAY_LABEL[day].zh}  ${DAY_LABEL[day].date}  巡回清单`, left, y + 13 * k);
  ctx.font = font(9);
  ctx.fillStyle = '#777';
  ctx.textAlign = 'right';
  ctx.fillText(`${pageNo} / ${pageTotal}`, right, y + 13 * k);
  ctx.textAlign = 'left';
  y += CHECK.headH * k;

  const colCode = left + 26 * k;
  const colName = left + 96 * k;
  const colCheck = right - 16 * k;

  for (const group of groups) {
    ctx.fillStyle = '#f0f2f5';
    ctx.fillRect(left, y, right - left, (CHECK.groupH - 5) * k);
    ctx.fillStyle = '#333';
    ctx.font = font(10, 700);
    ctx.fillText(group.hall, left + 6 * k, y + 12 * k);
    y += CHECK.groupH * k;

    for (const row of group.rows) {
      const [r, g, b] = row.rgb;
      const css = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

      ctx.beginPath();
      ctx.arc(left + 8 * k, y + 6 * k, 7 * k, 0, Math.PI * 2);
      if (row.index === null) {
        ctx.strokeStyle = css;
        ctx.lineWidth = 1.4 * k;
        ctx.stroke();
      } else {
        ctx.fillStyle = css;
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = font(7.5, 700);
        ctx.textAlign = 'center';
        ctx.fillText(String(row.index), left + 8 * k, y + 8.7 * k);
        ctx.textAlign = 'left';
      }

      ctx.fillStyle = '#111';
      ctx.font = font(10, 600);
      ctx.fillText(row.code, colCode, y + 9.5 * k);

      const textWidth = colCheck - colName - 22 * k;
      ctx.font = font(9.5);
      ctx.fillStyle = '#222';
      ctx.fillText(clip(ctx, row.entry.name || '—', textWidth), colName, y + 8.5 * k);

      if (row.entry.note) {
        ctx.font = font(8);
        ctx.fillStyle = '#888';
        ctx.fillText(clip(ctx, row.entry.note, textWidth), colName, y + 18 * k);
      }

      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1 * k;
      ctx.strokeRect(colCheck - 5 * k, y + 2 * k, 10 * k, 10 * k);

      y += CHECK.rowH * k;
      ctx.strokeStyle = '#eceff2';
      ctx.beginPath();
      ctx.moveTo(left, y - 2 * k);
      ctx.lineTo(right, y - 2 * k);
      ctx.stroke();
    }
  }
  return canvas;
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '…';
}
