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

/** Marker colours, also used as the sidebar colour picker. */
export const PALETTE = [
  { key: 'red', label: '红', css: '#e03131', rgb: [0.88, 0.19, 0.19] },
  { key: 'blue', label: '蓝', css: '#1971c2', rgb: [0.10, 0.44, 0.76] },
  { key: 'green', label: '绿', css: '#2f9e44', rgb: [0.18, 0.62, 0.27] },
  { key: 'orange', label: '橙', css: '#e8590c', rgb: [0.91, 0.35, 0.05] },
  { key: 'purple', label: '紫', css: '#7048e8', rgb: [0.44, 0.28, 0.91] },
  { key: 'teal', label: '青', css: '#0c8599', rgb: [0.05, 0.52, 0.60] },
];

export const colorOf = key =>
  PALETTE.find(c => c.key === key) || PALETTE[0];

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
