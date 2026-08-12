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
  const res = await fetch(`maps/${meta.source}`, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`地图文件缺失 maps/${meta.source}（${res.status}）`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50)) throw new Error('地图文件不是 PDF');
  // a mismatch means the committee re-issued the map, and the coordinates in
  // data/*.json were measured against a different file
  const verified = !meta.sha256 || (await sha256(bytes)) === meta.sha256;
  return { bytes, verified };
}
