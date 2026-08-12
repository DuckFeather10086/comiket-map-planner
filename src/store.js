/** Wishlist state: plain objects in localStorage, no server, no accounts. */

import { colorOf } from './layout.js';

const VERSION = 1;

const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export class Store extends EventTarget {
  constructor(event) {
    super();
    this.key = `comiket-planner:${event}`;
    this.event = event;
    this.day = 1;
    this.entries = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) || '{}');
      if (raw.version === VERSION && Array.isArray(raw.entries)) {
        this.entries = raw.entries;
      }
    } catch {
      /* corrupted or unavailable storage: start empty rather than break */
    }
  }

  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify({
        version: VERSION, event: this.event, entries: this.entries,
      }));
    } catch {
      /* private mode or quota: the session still works, it just will not persist */
    }
    this.dispatchEvent(new Event('change'));
  }

  /** Entries for one day, in insertion order. */
  forDay(day = this.day) {
    return this.entries.filter(e => e.day === day);
  }

  setDay(day) {
    this.day = day;
    this.dispatchEvent(new Event('day'));
  }

  add({ code, name = '', note = '', color = 'red', day = this.day }) {
    const entry = { id: uid(), day, code: code.trim(), name, note, color, pin: null };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  addMany(rows, day = this.day) {
    const added = rows.map(row => ({
      id: uid(), day, pin: null, color: 'red', name: '', note: '', ...row,
    }));
    this.entries.push(...added);
    this.save();
    return added;
  }

  update(id, patch) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.save();
  }

  remove(id) {
    this.entries = this.entries.filter(e => e.id !== id);
    this.save();
  }

  /** Replace the list wholesale, keeping only fields we understand. */
  replace(entries) {
    this.entries = entries.map(e => ({
      id: e.id || uid(),
      day: e.day === 2 ? 2 : 1,
      code: String(e.code || ''),
      name: String(e.name || ''),
      note: String(e.note || ''),
      // an import may carry a colour from before the levels, or none at all
      color: colorOf(e.color).key,
      pin: e.pin && Number.isFinite(e.pin.x) ? e.pin : null,
    })).filter(e => e.code);
    this.save();
  }

  clear() {
    this.entries = [];
    this.save();
  }

  toJSON() {
    return JSON.stringify({ version: VERSION, event: this.event, entries: this.entries }, null, 2);
  }

  toCSV() {
    const esc = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const lines = ['day,code,name,note,color'];
    for (const e of this.entries) {
      lines.push([e.day, e.code, e.name, e.note, e.color].map(esc).join(','));
    }
    return lines.join('\n');
  }
}

/**
 * Split pasted text into wishlist rows.  Accepts tab, comma or two-or-more
 * spaces between fields, so both a spreadsheet copy and a hand-typed list work.
 */
export function parsePaste(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\t|,|\s{2,}/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    rows.push({ code: parts[0], name: parts[1] || '', note: parts.slice(2).join(' ') });
  }
  return rows;
}
