/**
 * Text helpers for the exported PDF.
 *
 * The Japanese faces used here are CJK fallbacks with no Latin of their own, so
 * a string has to be split by script and each run drawn with the font that
 * actually carries it.
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
