/** On-screen map: one hall panel drawn on a canvas, with clickable spaces. */

import { allPanels, drawPanel, hitTest, markKey } from './mapdraw.js';
import { CanvasPen, fit } from './pens.js';

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 8;

export class Viewer extends EventTarget {
  constructor({ wrap, stage, canvas, layout }) {
    super();
    this.wrap = wrap;
    this.stage = stage;
    this.canvas = canvas;
    this.layout = layout;
    this.panels = allPanels(layout);
    this.index = 0;
    this.zoom = 1;
    this.marks = new Map();
    this.notes = [];

    canvas.addEventListener('click', ev => this._onClick(ev));
    canvas.addEventListener('mousemove', ev => this._onHover(ev));
    canvas.addEventListener('mouseleave', () => {
      this.canvas.style.cursor = '';
      this.dispatchEvent(new CustomEvent('hover', { detail: null }));
    });
  }

  get panel() { return this.panels[this.index]; }

  show(index) {
    this.index = Math.max(0, Math.min(this.panels.length - 1, index));
    this.render();
  }

  /** Jump to the panel holding a hall on a page. */
  showHall(pageIndex, hall) {
    const i = this.panels.findIndex(p => p.pageIndex === pageIndex && p.hall === hall);
    if (i >= 0 && i !== this.index) this.show(i);
    return i >= 0;
  }

  setMarks(marks, notes = []) {
    this.marks = marks;
    this.notes = notes;
    this.render();
  }

  setZoom(z) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    this.render();
  }

  zoomBy(f) { this.setZoom(this.zoom * f); }

  fitWidth() {
    this.zoom = 1;
    this.render();
  }

  /** The source box including room for the panel title. */
  drawBox() {
    const { box, header } = this.panel;
    return { x: box.x, y: box.y, w: box.w, h: box.h + header };
  }

  render() {
    const panel = this.panel;
    if (!panel) return;
    const box = this.drawBox();

    const avail = Math.max(320, this.wrap.clientWidth - 40);
    const base = avail / box.w;
    const s = base * this.zoom;
    const cssW = Math.round(box.w * s);
    const cssH = Math.round(box.h * s);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.stage.style.width = `${cssW}px`;
    this.stage.style.height = `${cssH}px`;

    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.transform = fit(box, { x: 0, y: 0, w: cssW, h: cssH });
    this.dpr = dpr;
    const pen = new CanvasPen(ctx, this.transform, dpr);
    drawPanel(pen, panel, this.marks, { notes: this.notes });

    this.scale = s;
    this.dispatchEvent(new Event('render'));
  }

  /** Canvas pixel position -> source PDF coordinates. */
  toSource(ev) {
    const r = this.canvas.getBoundingClientRect();
    const t = this.transform;
    const cx = ev.clientX - r.left;
    const cy = ev.clientY - r.top;
    return {
      x: t.box.x + (cx - t.ox) / t.s,
      y: t.box.y + t.box.h - (cy - t.oy) / t.s,
    };
  }

  /** Scroll a marked space into the middle of the viewport. */
  focus(block, number) {
    const panel = this.panel;
    const b = panel.blocks.find(v => v.block === block);
    if (!b || !this.transform) return;
    const t = this.transform;
    const rows = b.rows;
    const half = b.count / 2;
    const row = number <= half ? number - 1 : b.count - number;
    const [y0, y1] = rows[Math.max(0, Math.min(rows.length - 1, row))];
    const cx = t.ox + (b.x + b.w / 2 - t.box.x) * t.s;
    const cy = t.oy + (t.box.h - ((y0 + y1) / 2 - t.box.y)) * t.s;
    this.wrap.scrollTo({
      left: cx + this.stage.offsetLeft - this.wrap.clientWidth / 2,
      top: cy + this.stage.offsetTop - this.wrap.clientHeight / 2,
      behavior: 'smooth',
    });
  }

  _onClick(ev) {
    const p = this.toSource(ev);
    const hit = hitTest(this.panel, p.x, p.y);
    if (hit) {
      this.dispatchEvent(new CustomEvent('cellclick', { detail: hit }));
    }
  }

  _onHover(ev) {
    const p = this.toSource(ev);
    const hit = hitTest(this.panel, p.x, p.y);
    this.canvas.style.cursor = hit ? 'pointer' : '';
    const key = hit ? markKey(hit.block, hit.number) : null;
    if (key !== this._hoverKey) {
      this._hoverKey = key;
      this.dispatchEvent(new CustomEvent('hover', { detail: hit }));
    }
  }
}
