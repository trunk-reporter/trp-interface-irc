// Pure helpers for global transcript search: query expansion, hit merging, snippet sanitizing.

const MAX_VARIANTS = 8;
const DIRS = { n: 'north', s: 'south', e: 'east', w: 'west' };
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const ORD_NUM = ORD.map((_, i) => { const n = i + 1; const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; return n + s; });
const SUFFIX = { st: 'street', ave: 'avenue', rd: 'road', dr: 'drive', blvd: 'boulevard', ln: 'lane', ct: 'court' };

const uniq = a => [...new Set(a)];
const swap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const DIRS_REV = swap(DIRS), SUFFIX_REV = swap(SUFFIX);

/** Alternatives for one token: as written first, then fuller words, then abbreviations; '' = dropped. */
function alternatives(tok, first) {
  const alts = [tok];
  if (DIRS[tok]) alts.push(DIRS[tok]);
  else if (DIRS_REV[tok]) alts.push(DIRS_REV[tok]);
  const oi = ORD_NUM.indexOf(tok);
  if (oi >= 0) alts.push(ORD[oi]);
  else if (ORD.includes(tok)) alts.push(ORD_NUM[ORD.indexOf(tok)]);
  if (SUFFIX[tok]) alts.push(SUFFIX[tok], '');
  else if (SUFFIX_REV[tok]) alts.push(SUFFIX_REV[tok], '');
  if (first && /^\d{1,4}$/.test(tok) && tok.length > 1) alts.push(tok.split('').join('-'));
  return uniq(alts);
}

/** Search-query variants (original first, <= 8) covering abbreviations, ordinals and house numbers. */
export function expandQuery(text) {
  const norm = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(norm)) return [];
  const toks = norm.split(' ');
  // Beam of partial variants ranked by how far they stray from the original; stable sort keeps original first.
  let beam = [{ parts: [], cost: 0 }];
  toks.forEach((tok, i) => {
    const alts = alternatives(tok, i === 0);
    const next = [];
    for (const b of beam) alts.forEach((a, k) => next.push({ parts: [...b.parts, a], cost: b.cost + k }));
    next.sort((x, y) => x.cost - y.cost);
    beam = next.slice(0, 64);
  });
  const out = uniq([norm, ...beam.map(b => b.parts.filter(Boolean).join(' '))].filter(Boolean));
  return out.slice(0, MAX_VARIANTS);
}

/** Merge hit lists, dedupe by path, newest (startMs) first. */
export function mergeHits(lists) {
  const seen = new Map();
  for (const list of lists) for (const h of list || []) if (!seen.has(h.path)) seen.set(h.path, h);
  return [...seen.values()].sort((a, b) => (b.startMs || 0) - (a.startMs || 0));
}

/** Escape server snippet HTML, but keep <b>...</b> highlights. */
export function safeSnippet(html) {
  return String(html ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
}
