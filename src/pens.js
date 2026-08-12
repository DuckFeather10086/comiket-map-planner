/**
 * Drawing backends for the map.
 *
 * `mapdraw` emits calls in source PDF coordinates (y upwards); a pen applies the
 * transform and talks to either a canvas or a pdf-lib page.  Keeping both behind
 * the same three primitives is what stops the screen map and the printed map
 * from drifting apart.
 */

/** Scale/offset that fits a source box into a target rectangle. */
export function fit(box, target) {
  const s = Math.min(target.w / box.w, target.h / box.h);
  return {
    s,
    ox: target.x + (target.w - box.w * s) / 2,
    oy: target.y + (target.h - box.h * s) / 2,
    box,
  };
}

const css = ([r, g, b]) =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

const NON_LATIN = /[^\u0000-\u00ff]/;

/** Break a string into consecutive runs of the same script. */
function splitRuns(str) {
  const runs = [];
  for (const ch of str) {
    const cjk = NON_LATIN.test(ch);
    const last = runs.at(-1);
    if (last && last.cjk === cjk) last.text += ch;
    else runs.push({ text: ch, cjk });
  }
  return runs;
}

export class CanvasPen {
  /**
   * @param ctx  2d context
   * @param t    transform from fit()
   * @param dpr  device pixel ratio already applied to the canvas size
   */
  constructor(ctx, t, dpr = 1) {
    this.ctx = ctx;
    this.t = t;
    this.k = dpr;
  }

  x(v) { return (this.t.ox + (v - this.t.box.x) * this.t.s) * this.k; }
  // canvas y grows downwards, source y grows upwards
  y(v) { return (this.t.oy + (this.t.box.h - (v - this.t.box.y)) * this.t.s) * this.k; }
  u(v) { return v * this.t.s * this.k; }

  rect(x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) {
    const ctx = this.ctx;
    const px = this.x(x), py = this.y(y + h);
    const pw = this.u(w), ph = this.u(h);
    if (fill) {
      ctx.fillStyle = css(fill);
      ctx.fillRect(px, py, pw, ph);
    }
    if (stroke) {
      ctx.strokeStyle = css(stroke);
      ctx.lineWidth = Math.max(0.5, this.u(lineWidth));
      ctx.strokeRect(px, py, pw, ph);
    }
  }

  circle(x, y, r, { fill, stroke, lineWidth = 0.5 } = {}) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(this.x(x), this.y(y), this.u(r), 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = css(fill);
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = css(stroke);
      ctx.lineWidth = Math.max(0.5, this.u(lineWidth));
      ctx.stroke();
    }
  }

  text(str, x, y, { size = 6, align = 'left', middle = false, color = [0, 0, 0],
                    weight = 400 } = {}) {
    const px = this.u(size);
    if (px < 3.2) return;                 // unreadable at this zoom, skip the work
    const ctx = this.ctx;
    ctx.font = `${weight} ${px}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.fillStyle = css(color);
    ctx.textAlign = align;
    ctx.textBaseline = middle ? 'middle' : 'alphabetic';
    ctx.fillText(str, this.x(x), this.y(y));
  }
}

export class PdfPen {
  /**
   * @param page   pdf-lib PDFPage
   * @param t      transform from fit()
   * @param fonts  {latin, cjk} embedded fonts
   * @param rgb    pdf-lib rgb()
   */
  constructor(page, t, fonts, rgb) {
    this.page = page;
    this.t = t;
    this.fonts = fonts;
    this.rgb = rgb;
  }

  x(v) { return this.t.ox + (v - this.t.box.x) * this.t.s; }
  y(v) { return this.t.oy + (v - this.t.box.y) * this.t.s; }
  u(v) { return v * this.t.s; }

  rect(x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) {
    const opts = {
      x: this.x(x), y: this.y(y), width: this.u(w), height: this.u(h),
    };
    if (fill) opts.color = this.rgb(...fill);
    if (stroke) {
      opts.borderColor = this.rgb(...stroke);
      opts.borderWidth = this.u(lineWidth);
    }
    this.page.drawRectangle(opts);
  }

  circle(x, y, r, { fill, stroke, lineWidth = 0.5 } = {}) {
    const opts = { x: this.x(x), y: this.y(y), size: this.u(r) };
    if (fill) opts.color = this.rgb(...fill);
    if (stroke) {
      opts.borderColor = this.rgb(...stroke);
      opts.borderWidth = this.u(lineWidth);
    }
    this.page.drawCircle(opts);
  }

  /**
   * The embedded subset carries only the fixed kana/kanji the map draws, so a
   * string is split into script runs and each run goes to the font that has it:
   * kana to the subset, everything ASCII to a built-in face that costs nothing
   * to ship.  Latin block letters and space numbers therefore need no font data
   * at all.
   */
  text(str, x, y, { size = 6, align = 'left', middle = false, color = [0, 0, 0],
                    weight = 400 } = {}) {
    const s = this.u(size);
    const pick = run => run.cjk ? this.fonts.cjk
                                : (weight >= 600 ? this.fonts.bold : this.fonts.latin);
    const runs = splitRuns(str);
    const total = runs.reduce((w, r) => w + pick(r).widthOfTextAtSize(r.text, s), 0);

    let px = this.x(x);
    if (align === 'center') px -= total / 2;
    else if (align === 'right') px -= total;
    const py = middle ? this.y(y) - s * 0.35 : this.y(y);
    const colour = this.rgb(...color);
    for (const run of runs) {
      const font = pick(run);
      this.page.drawText(run.text, { x: px, y: py, size: s, font, color: colour });
      px += font.widthOfTextAtSize(run.text, s);
    }
  }
}
