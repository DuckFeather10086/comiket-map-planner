/** On-screen map: a pdf.js-rendered page with a marker layer on top. */

import * as pdfjs from '../vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;

export class Viewer extends EventTarget {
  constructor({ wrap, stage, mapCanvas, markerCanvas }) {
    super();
    this.wrap = wrap;
    this.stage = stage;
    this.mapCanvas = mapCanvas;
    this.markerCanvas = markerCanvas;
    this.scale = 1;
    this.pageIndex = 0;
    this.markers = [];
    this.highlightId = null;
    this.placing = false;
    this._renderToken = 0;

    markerCanvas.addEventListener('click', ev => this._onClick(ev));
  }

  async open(bytes) {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy and
    // keep ours for the exporter.
    this.pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    return this.pdf.numPages;
  }

  async show(pageIndex, scale = this.scale) {
    this.pageIndex = pageIndex;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const token = ++this._renderToken;

    const page = await this.pdf.getPage(pageIndex + 1);
    if (token !== this._renderToken) return;

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
    if (token !== this._renderToken) return;

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

  setPlacing(on) {
    this.placing = on;
    this.wrap.classList.toggle('placing', on);
  }

  /** @param {Array<{rect?, point?, css: string, index: number, active: boolean}>} markers */
  drawMarkers(markers) {
    this.markers = markers;
    const canvas = this.markerCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.viewport) return;

    const k = this.dpr;
    ctx.lineJoin = 'round';

    for (const marker of markers) {
      const box = marker.rect ? this._box(marker.rect) : null;
      if (box) {
        ctx.fillStyle = marker.css;
        ctx.globalAlpha = marker.active ? 0.55 : 0.34;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = marker.css;
        ctx.lineWidth = (marker.active ? 2.6 : 1.6) * k;
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }

      const [cx, cy] = marker.point
        ? this.viewport.convertToViewportPoint(marker.point.x, marker.point.y)
        : [box.x + box.w, box.y];

      if (marker.point) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx - 6 * k, cy - 14 * k);
        ctx.lineTo(cx + 6 * k, cy - 14 * k);
        ctx.closePath();
        ctx.fillStyle = marker.css;
        ctx.fill();
      }

      const r = (marker.active ? 11 : 9) * k;
      const bx = marker.point ? cx : cx + r * 0.2;
      const by = marker.point ? cy - 14 * k - r * 0.6 : cy - r * 0.2;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = marker.css;
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
    const [x, y] = marker.rect
      ? this.viewport.convertToViewportPoint(
          (marker.rect.x0 + marker.rect.x1) / 2, (marker.rect.y0 + marker.rect.y1) / 2)
      : this.viewport.convertToViewportPoint(marker.point.x, marker.point.y);
    this.wrap.scrollTo({
      left: x / this.dpr + this.stage.offsetLeft - this.wrap.clientWidth / 2,
      top: y / this.dpr + this.stage.offsetTop - this.wrap.clientHeight / 2,
      behavior: 'smooth',
    });
  }

  _box(rect) {
    const [x0, y1] = this.viewport.convertToViewportPoint(rect.x0, rect.y1);
    const [x1, y0] = this.viewport.convertToViewportPoint(rect.x1, rect.y0);
    return { x: x0, y: y1, w: x1 - x0, h: y0 - y1 };
  }

  _onClick(ev) {
    if (!this.viewport) return;
    const rect = this.markerCanvas.getBoundingClientRect();
    const vx = (ev.clientX - rect.left) * this.dpr;
    const vy = (ev.clientY - rect.top) * this.dpr;
    const [x, y] = this.viewport.convertToPdfPoint(vx, vy);
    this.dispatchEvent(new CustomEvent('mapclick', {
      detail: { page: this.pageIndex, x, y },
    }));
  }
}
