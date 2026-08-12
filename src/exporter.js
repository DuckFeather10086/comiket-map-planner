/**
 * PDF output: the map is drawn, not borrowed.
 *
 * Every sheet comes out of the same `mapdraw` routine that paints the screen, so
 * what you print is what you saw.  Sheets are all vector: the space grid and
 * markers as shapes, kana block letters and hall names through a 9 kB font
 * subset holding only those glyphs, everything ASCII through the built-in
 * Helvetica.  The one raster part is the checklist, painted on a canvas because
 * circle names are arbitrary Japanese and a font covering them would be megabytes.
 */

import { colorOf } from './layout.js';
import { allPanels, drawPanel, markKey } from './mapdraw.js';
import { PdfPen, fit } from './pens.js';

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
  const page = layout.page(m.r.page ?? 9);
  if (!m.r.ok) return [m.r.page ?? 9, 99, 9e9, m.r.number ?? 9e9];
  return [m.r.page, page.halls.indexOf(m.r.hall), m.r.rect.block.x, m.r.number];
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
        const placed = new Set(markers.map(m => m.entry.id));
        await addChecklist(doc, plan.day, markers,
                           plan.entries.filter(e => !placed.has(e.id)), orphans);
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

const CHECK = { dpi: 2.6, margin: 34, rowH: 22, headH: 34, groupH: 22 };

async function addChecklist(doc, day, markers, unplaced, orphans) {
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

  const pages = paginate(groups);
  for (const [i, rows] of pages.entries()) {
    const canvas = paintChecklist(rows, day, i + 1, pages.length);
    const png = await doc.embedPng(canvas.toDataURL('image/png'));
    doc.addPage([A4.w, A4.h])
      .drawImage(png, { x: 0, y: 0, width: A4.w, height: A4.h });
  }
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
  ctx.fillText(`${DAY_LABEL[day].jp}  ${DAY_LABEL[day].date}  巡回清单`, left, y + 13 * k);
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
      const [r, g, b] = colorOf(row.color).rgb;
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

      const width = colCheck - colName - 22 * k;
      ctx.font = font(9.5);
      ctx.fillStyle = '#222';
      ctx.fillText(clip(ctx, row.entry.name || '—', width), colName, y + 8.5 * k);
      if (row.entry.note) {
        ctx.font = font(8);
        ctx.fillStyle = '#888';
        ctx.fillText(clip(ctx, row.entry.note, width), colName, y + 18 * k);
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
