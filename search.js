// Pure helpers for global transcript search: query expansion, hit merging, snippet sanitizing.

const MAX_VARIANTS = 8;
const MAX_EXPAND_TOKENS = 12;
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
  const all = norm.split(' ');
  const toks = all.slice(0, MAX_EXPAND_TOKENS);   // bound work on huge input
  const rest = all.slice(MAX_EXPAND_TOKENS);      // appended unexpanded
  // Beam of partial variants ranked by how far they stray from the original; stable sort keeps original first.
  let beam = [{ parts: [], cost: 0 }];
  toks.forEach((tok, i) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(tok);
    const [, pre, core, post] = m;
    // Expand on the core word; the as-written form keeps its edge punctuation, expansions drop it.
    const alts = core ? alternatives(core, i === 0).map((a, k) => (k === 0 ? tok : a)) : [tok];
    const next = [];
    for (const b of beam) alts.forEach((a, k) => next.push({ parts: [...b.parts, a], cost: b.cost + k + (a === '' ? 2 : 0) + (/^\d(-\d)+$/.test(a) ? 3 : 0) }));
    next.sort((x, y) => x.cost - y.cost);
    beam = next.slice(0, 64);
  });
  const out = uniq([norm, ...beam.map(b => [...b.parts.filter(Boolean), ...rest].join(' '))].filter(Boolean));
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

/**
 * Parallel search runner. getJson(path, signal) -> Promise<{hits, more, before}>.
 * run/more resolve null when superseded by a newer run() or cancel().
 */
export function createSearch(getJson, opts = {}) {
  const limit = opts.limit || 30;
  let ctrl = null;
  let gen = 0;
  let cur = null;   // { query, variants: [{q, hits, more, before}], failed }

  const url = (q, before) => `/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}` + (before != null ? `&before=${before}` : '');
  const state = () => {
    const hits = mergeHits(cur.variants.map(v => v.hits));
    return { hits, hasMore: cur.variants.some(v => v.more), failed: cur.failed, total: hits.length, query: cur.query };
  };

  function cancel() {
    gen++;
    if (ctrl) ctrl.abort();
    ctrl = null;
    cur = null;   // no committed state until a run completes
  }

  /** Query the given variants; returns null if superseded. Updates cur in place. */
  async function fetchAll(targets, myGen, signal) {
    const settled = await Promise.allSettled(targets.map(v => getJson(url(v.q, v.paged ? v.before : null), signal)));
    if (myGen !== gen) return null;
    let failures = 0;
    settled.forEach((r, i) => {
      const v = targets[i];
      if (r.status === 'fulfilled') {
        const d = r.value || {};
        v.hits = [...v.hits, ...(d.hits || [])];
        v.more = !!d.more;
        v.before = d.before;
        v.paged = true;
      } else {
        failures++;
        v.more = false;
      }
    });
    return failures;
  }

  async function run(text) {
    cancel();
    const query = String(text || '').trim();
    const myGen = gen;
    const qs = expandQuery(query);
    if (!qs.length) { cur = { query: '', variants: [], failed: 0 }; return state(); }
    ctrl = new AbortController();
    const variants = qs.map(q => ({ q, hits: [], more: false, before: null, paged: false }));
    const next = { query, variants, failed: 0 };
    const failures = await fetchAll(variants, myGen, ctrl.signal);
    if (failures === null) return null;
    if (failures === variants.length) { cur = null; ctrl = null; throw new Error('search failed'); }
    next.failed = failures;
    cur = next;
    return state();
  }

  async function more() {
    const mine = cur;
    if (!mine || !ctrl) return { hits: [], hasMore: false, failed: 0, total: 0, query: '' };
    const targets = mine.variants.filter(v => v.more);
    if (!targets.length) return state();
    const myGen = gen;
    const failures = await fetchAll(targets, myGen, ctrl.signal);
    if (failures === null || mine !== cur) return null;
    mine.failed += failures;
    return state();
  }

  return { run, more, cancel };
}
