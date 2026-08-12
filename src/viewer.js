/**
 * On-screen map: the official hall map rendered by pdf.js, with a marker layer
 * on top.
 *
 * The overlay and the click targets both come from the extracted space
 * rectangles, so a click lands on the same cell the exporter will stamp.
 */

import * as pdfjs from '../vendor/pdf.mjs';
import { colorOf } from './layout.js';
import { hitTestPage, markKey } from './mapdraw.js';

pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

export class Viewer extends EventTarget {
  constructor({ wrap, stage, mapCanvas, markerCanvas, layout }) {
    super();
    this.wrap = wrap;
    this.stage = stage;
    this.mapCanvas = mapCanvas;
    this.markerCanvas = markerCanvas;
    this.layout = layout;
    this.scale = 1;
    this.pageIndex = 0;
    this.markers = [];
    this._token = 0;

    markerCanvas.addEventListener('click', ev => this._onClick(ev));
    markerCanvas.addEventListener('mousemove', ev => this._onHover(ev));
    markerCanvas.addEventListener('mouseleave', () => {
      markerCanvas.style.cursor = '';
      this.dispatchEvent(new CustomEvent('hover', { detail: null }));
    });
  }

  async open(bytes) {
    // pdf.js takes ownership of the buffer it is handed, so give it a copy and
    // keep ours for the exporter
    this.pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    return this.pdf.numPages;
  }

  async show(pageIndex, scale = this.scale) {
    this.pageIndex = pageIndex;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const token = ++this._token;

    const page = await this.pdf.getPage(pageIndex + 1);
    if (token !== this._token) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewport = page.getViewport({ scale: this.scale * dpr });
    const cssW = this.viewport.width / dpr;
    const cssH = this.viewport.height / dpr;

    for (const canvas of [this.mapCanvas, this.markerCanvas]) {
      canvas.width = Math.round(this.viewport.width);
      canvas.height = Math.round(this.viewport.height);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    this.stage.style.width = `${cssW}px`;
    this.stage.style.height = `${cssH}px`;
    this.dpr = dpr;

    const ctx = this.mapCanvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.mapCanvas.width, this.mapCanvas.height);
    await page.render({ canvasContext: ctx, viewport: this.viewport }).promise;
    if (token !== this._token) return;

    this.drawMarkers(this.markers);
    this.dispatchEvent(new Event('render'));
  }

  fitWidth() {
    if (!this.viewport) return;
    const avail = this.wrap.clientWidth - 48;
    const natural = this.viewport.width / (this.scale * this.dpr);
    return this.show(this.pageIndex, avail / natural);
  }

  zoomBy(factor) {
    return this.show(this.pageIndex, this.scale * factor);
  }

  /** @param {Array<{rect, index, color, active, approx}>} markers */
  drawMarkers(markers) {
    this.markers = markers;
    const canvas = this.markerCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.viewport) return;

    const k = this.dpr;
    for (const marker of markers) {
      const css = colorOf(marker.color).css;
      const box = this._box(marker.rect);

      ctx.fillStyle = css;
      ctx.globalAlpha = marker.active ? 0.55 : (marker.approx ? 0.22 : 0.38);
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = css;
      ctx.lineWidth = (marker.active ? 2.6 : 1.6) * k;
      if (marker.approx) ctx.setLineDash([3 * k, 2 * k]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);

      const r = (marker.active ? 11 : 9) * k;
      const bx = box.x + box.w + r * 0.6;
      const by = box.y + box.h / 2;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = css;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.6 * k;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(marker.index), bx, by + 0.5 * k);
    }
  }

  /** Scroll a marker into the middle of the viewport. */
  focus(marker) {
    if (!this.viewport) return;
    const box = this._box(marker.rect);
    this.wrap.scrollTo({
      left: (box.x + box.w / 2) / this.dpr + this.stage.offsetLeft
            - this.wrap.clientWidth / 2,
      top: (box.y + box.h / 2) / this.dpr + this.stage.offsetTop
           - this.wrap.clientHeight / 2,
      behavior: 'smooth',
    });
  }

  _box(rect) {
    const [x0, y1] = this.viewport.convertToViewportPoint(rect.x, rect.y + rect.h);
    const [x1, y0] = this.viewport.convertToViewportPoint(rect.x + rect.w, rect.y);
    return { x: x0, y: y1, w: x1 - x0, h: y0 - y1 };
  }

  _source(ev) {
    const r = this.markerCanvas.getBoundingClientRect();
    const [x, y] = this.viewport.convertToPdfPoint(
      (ev.clientX - r.left) * this.dpr, (ev.clientY - r.top) * this.dpr);
    return { x, y };
  }

  _onClick(ev) {
    if (!this.viewport) return;
    const { x, y } = this._source(ev);
    const hit = hitTestPage(this.layout, this.pageIndex, x, y);
    if (hit) this.dispatchEvent(new CustomEvent('cellclick', { detail: hit }));
  }

  _onHover(ev) {
    if (!this.viewport) return;
    const { x, y } = this._source(ev);
    const hit = hitTestPage(this.layout, this.pageIndex, x, y);
    this.markerCanvas.style.cursor = hit ? 'pointer' : '';
    const key = hit ? markKey(hit.block, hit.number) : null;
    if (key !== this._hoverKey) {
      this._hoverKey = key;
      this.dispatchEvent(new CustomEvent('hover', { detail: hit }));
    }
  }
}
