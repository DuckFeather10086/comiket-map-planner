/**
 * Text helpers for the exported PDF.
 *
 * The Japanese faces used here are CJK fallbacks with no Latin of their own, so
 * a string has to be split by script and each run drawn with the font that
 * actually carries it.  Everything below takes the same `fonts` bag the exporter
 * builds: `latin`, `bold` and - once a sheet needs Japanese - `jp`.
 */

const NON_LATIN = /[^\u0000-\u00ff]/;

/** Break a string into consecutive runs of the same script. */
export function splitRuns(str) {
  const runs = [];
  for (const ch of str) {
    const cjk = NON_LATIN.test(ch);
    const last = runs.at(-1);
    if (last && last.cjk === cjk) last.text += ch;
    else runs.push({ text: ch, cjk });
  }
  return runs;
}

function pickFont(run, fonts, bold) {
  return run.cjk ? fonts.jp : (bold ? fonts.bold : fonts.latin);
}

/** How wide a string comes out, across however many faces it needs. */
export function measure(text, size, fonts, bold = false) {
  return splitRuns(text).reduce(
    (w, run) => w + pickFont(run, fonts, bold).widthOfTextAtSize(run.text, size), 0);
}

/** Draw a string, run by run.  `align` moves x to the right or middle of it. */
export function write(page, text, x, y, { size, fonts, bold = false, color, align }) {
  let px = x;
  if (align === 'right') px -= measure(text, size, fonts, bold);
  if (align === 'center') px -= measure(text, size, fonts, bold) / 2;
  for (const run of splitRuns(text)) {
    const font = pickFont(run, fonts, bold);
    page.drawText(run.text, { x: px, y, size, font, color });
    px += font.widthOfTextAtSize(run.text, size);
  }
}

/** Trim a string to fit, with an ellipsis if anything came off. */
export function clip(text, size, fonts, maxWidth) {
  if (measure(text, size, fonts) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measure(out + '…', size, fonts) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '…';
}
