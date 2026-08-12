/**
 * The official hall map, shipped with the site.
 *
 * It is a freely published PDF and lives in maps/, so there is nothing to ask
 * the user for: fetch it, check it is the same file the coordinates were
 * measured against, and hand the bytes on.
 */

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {{source: string, sha256?: string}} meta layout header
 * @returns {Promise<{bytes: Uint8Array, verified: boolean}>}
 */
export async function loadMap(meta) {
  const url = `maps/${meta.source}`;
  // plain fetch, so the etag decides: an earlier build of this site asked for
  // the same URL when the map was not shipped yet, and a cached 404 from then
  // would otherwise be replayed forever.  Retry past the cache if anything is
  // wrong with the first answer.
  let res = await fetch(url);
  if (!res.ok) res = await fetch(url, { cache: 'reload' });
  if (!res.ok) {
    throw new Error(`地图文件读取失败 ${url}（${res.status}）`
                    + '，请强制刷新一次（Ctrl/Cmd+Shift+R）');
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50)) {
    throw new Error('地图文件不是 PDF，请强制刷新一次（Ctrl/Cmd+Shift+R）');
  }
  // a mismatch means the committee re-issued the map, and the coordinates in
  // data/*.json were measured against a different file
  const verified = !meta.sha256 || (await sha256(bytes)) === meta.sha256;
  return { bytes, verified };
}
