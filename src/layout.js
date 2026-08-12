/**
 * Space-code resolution against the extracted map layout.
 *
 * The layout JSON produced by tools/extract_layout.py lists, per block, the
 * PDF-space rectangle of every table row.  A block with N spaces has N/2 rows:
 * the right-hand column runs 1..N/2 upwards from the bottom row, the left-hand
 * column runs N/2+1..N downwards from the top, so the two cells on one row add
 * up to N+1.  Wall blocks have no such grid; they come as strips of printed
 * cells, listed per page.
 */

import { stripCellRect } from './mapdraw.js';

/**
 * How badly you want to be somewhere, in the order you would go.
 *
 * The colour is the plan: red means be in the queue before the doors open,
 * yellow means get there today, blue means only if you walk past.  Markers, list
 * badges and the printed sheets all read their colour from here, and the printed
 * sheets carry the `tag`/`en` wording so a sheet works without the app.
 *
 * `ink` is what goes on top of the colour - yellow needs dark text where the
 * other two take white.
 */
export const PALETTE = [
  { key: 'red', tag: 'P1', short: '必去', en: 'GO FIRST',
    label: '开场就得冲 · 排队也要拿到',
    css: '#e03131', rgb: [0.88, 0.19, 0.19], ink: [1, 1, 1], inkCss: '#fff' },
  { key: 'amber', tag: 'P2', short: '要去', en: 'ANYTIME',
    label: '当天一定要去 · 但不用赶开场',
    css: '#f59f00', rgb: [0.96, 0.62, 0.00], ink: [0.25, 0.16, 0.02],
    inkCss: '#40290a' },
  { key: 'blue', tag: 'P3', short: '路过', en: 'IF PASSING',
    label: '顺路瞅一眼 · 没时间就算了',
    css: '#1971c2', rgb: [0.10, 0.44, 0.76], ink: [1, 1, 1], inkCss: '#fff' },
];

/** Colours from before the levels meant something, and what they became. */
const FOLDED = { orange: 'amber', yellow: 'amber', green: 'blue',
                 teal: 'blue', purple: 'blue' };

export const colorOf = key =>
  PALETTE.find(c => c.key === (FOLDED[key] || key)) || PALETTE[0];

/** The most urgent level among some entries, for a per-hall summary. */
export const topColor = entries => {
  const ranks = entries.map(e => PALETTE.indexOf(colorOf(e.color)));
  return PALETTE[Math.min(...ranks)];
};

const FULLWIDTH = /[！-～]/g;
const DASHES = /[-‐-―−ー－~]/g;

/** Fold full-width latin/digits and the many dash glyphs people type. */
function normalise(text) {
  return String(text)
    .replace(FULLWIDTH, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(DASHES, '-')
    .trim();
}

export class Layout {
  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`layout ${res.status}`);
    return new Layout(await res.json());
  }

  constructor(doc) {
    this.doc = doc;
    /** block letter -> block record (letters are unique across the event) */
    this.blocks = new Map();
    /** wall blocks: recognised by name whether or not a strip carries them */
    this.walls = new Map();
    /** "ア-31" -> the printed strip that space sits in */
    this.wallStrips = new Map();
    doc.pages.forEach((page, index) => {
      for (const block of page.blocks) {
        this.blocks.set(block.block, { ...block, page: index });
      }
      for (const wall of page.walls || []) {
        this.walls.set(wall.block, { ...wall, page: index });
      }
      for (const strip of page.wallStrips || []) {
        const step = strip.to >= strip.from ? 1 : -1;
        for (let n = strip.from; n !== strip.to + step; n += step) {
          this.wallStrips.set(`${strip.block}-${n}`, { ...strip, page: index });
        }
      }
    });

    const letters = [...this.blocks.keys(), ...this.walls.keys()].join('');
    this.codeRe = new RegExp(`([${letters}])\\s*-?\\s*(\\d{1,3})\\s*([abAB])?`);
    this.halls = [...new Set([...this.blocks.values()].map(b => b.hall))];
  }

  /** The printed wall strip holding a space, if the map shows one. */
  wallStrip(block, number) {
    return this.wallStrips.get(`${block}-${number}`) || null;
  }

  get event() { return this.doc.event; }
  get pages() { return this.doc.pages; }
  page(index) { return this.doc.pages[index]; }
  /** The site plan printed on one of the sheets, if this map carries one. */
  get overview() { return this.doc.overview || null; }

  /**
   * Parse a written placement such as "東ヨ-12a", "ヨ12", "西1 あ-05b".
   * Returns null when no block letter is recognisable.
   */
  parse(code) {
    const match = this.codeRe.exec(normalise(code));
    if (!match) return null;
    return {
      block: match[1],
      number: parseInt(match[2], 10),
      sub: (match[3] || '').toLowerCase(),
    };
  }

  /** The PDF-space rectangle of one space, or null if it does not exist. */
  cell(blockLetter, number) {
    const block = this.blocks.get(blockLetter);
    if (!block) return null;
    const half = block.count / 2;
    if (!Number.isInteger(number) || number < 1 || number > block.count) return null;

    let row, right;
    if (number <= half) {
      row = number - 1;             // right column, counting up from the bottom
      right = true;
    } else {
      row = block.count - number;   // left column, counting down from the top
      right = false;
    }
    if (block.mirror) right = !right;

    const [y0, y1] = block.rows[row];
    const halfWidth = block.w / 2;
    const x0 = block.x + (right ? halfWidth : 0);
    return { x0, y0, x1: x0 + halfWidth, y1, page: block.page, block };
  }

  /**
   * Resolve a written placement to a page, rectangle and canonical form.
   * `reason` explains a miss so the UI can tell "unknown block" from "no such
   * space in that block".
   */
  resolve(code) {
    const parsed = this.parse(code);
    if (!parsed) return { ok: false, reason: 'unparsed' };

    const wall = this.walls.get(parsed.block);
    if (wall) {
      // wall spaces are placed only where the printed map draws a cell for
      // them; anything else is reported, never guessed at
      const strip = this.wallStrip(parsed.block, parsed.number);
      if (strip) {
        return {
          ok: true, wall: true, strip, ...parsed,
          hall: strip.hall, page: strip.page,
          canonical: `${strip.hall}${parsed.block}-`
                     + `${String(parsed.number).padStart(2, '0')}${parsed.sub}`,
        };
      }
      return { ok: false, reason: 'wall', ...parsed, hall: wall.hall, page: wall.page };
    }

    const block = this.blocks.get(parsed.block);
    if (!block) return { ok: false, reason: 'block', ...parsed };

    const rect = this.cell(parsed.block, parsed.number);
    if (!rect) {
      return { ok: false, reason: 'number', ...parsed, max: block.count, hall: block.hall };
    }
    return {
      ok: true,
      ...parsed,
      hall: block.hall,
      page: block.page,
      rect,
      canonical: `${block.hall}${parsed.block}-${String(parsed.number).padStart(2, '0')}${parsed.sub}`,
    };
  }
}
