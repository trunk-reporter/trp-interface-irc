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

// Costs rank forms that real transcripts use: full words and a dropped suffix are cheap,
// letter abbreviations (w, st) are dear, spelled-out house numbers dearest.
const ABBR = 4, ORD_SWAP = 1, SUFFIX_FULL = 2, DIGITS = 6;

/** Alternatives [form, cost] for one token; the first is the token as written; '' = dropped. */
function alternatives(tok, first) {
  const alts = [];
  const add = (a, c) => alts.push([a, c]);
  const oi = ORD_NUM.indexOf(tok), wi = ORD.indexOf(tok);
  if (DIRS[tok]) { add(tok, ABBR); add(DIRS[tok], 0); }
  else if (DIRS_REV[tok]) { add(tok, 0); add(DIRS_REV[tok], ABBR); }
  else if (oi >= 0) { add(tok, 0); add(ORD[oi], ORD_SWAP); }
  else if (wi >= 0) { add(tok, 0); add(ORD_NUM[wi], ORD_SWAP); }
  else if (SUFFIX[tok]) { add(tok, ABBR); add(SUFFIX[tok], SUFFIX_FULL); add('', 0); }
  else if (SUFFIX_REV[tok]) { add(tok, SUFFIX_FULL); add(SUFFIX_REV[tok], ABBR); add('', 0); }
  else add(tok, 0);
  if (first && /^\d{1,4}$/.test(tok) && tok.length > 1) add(tok.split('').join('-'), DIGITS);
  return alts;
}

/** Search-query variants (original first, <= 8) covering abbreviations, ordinals and house numbers. */
export function expandQuery(text) {
  const norm = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(norm)) return [];
  const all = norm.split(' ');
  const toks = all.slice(0, MAX_EXPAND_TOKENS);   // bound work on huge input
  const rest = all.slice(MAX_EXPAND_TOKENS);      // appended unexpanded
  // Beam of partial variants ranked by cost (see alternatives); the original is always emitted first.
  let beam = [{ parts: [], cost: 0 }];
  toks.forEach((tok, i) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(tok);
    const [, pre, core, post] = m;
    // Expand on the core word; the as-written form keeps its edge punctuation, expansions drop it.
    const alts = core ? alternatives(core, i === 0).map(([a, c], k) => [k === 0 ? tok : a, c]) : [[tok, 0]];
    const next = [];
    for (const b of beam) for (const [a, c] of alts) next.push({ parts: [...b.parts, a], cost: b.cost + c });
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
  // Each variant pages on its own cursor. Only show hits down to the watermark (the newest cursor of any
  // variant that still has more), so a later page can only add hits below what is already shown.
  const state = () => {
    const paging = cur.variants.filter(v => v.more && typeof v.before === 'number');
    const mark = paging.length ? Math.max(...paging.map(v => v.before)) : -Infinity;
    const hits = mergeHits(cur.variants.map(v => v.hits)).filter(h => (h.startMs || 0) >= mark);
    return { hits, hasMore: cur.variants.some(v => v.more), failed: cur.failed, total: hits.length, query: cur.query };
  };

  function cancel() {
    gen++;
    if (ctrl) ctrl.abort();
    ctrl = null;
    cur = null;   // no committed state until a run completes
  }

  /** Query the given variants; returns null if superseded, else {failures, firstError}. Updates variants in place.
   *  A failed variant keeps its more/before so a later more() retries it. */
  async function fetchAll(targets, myGen, signal) {
    const settled = await Promise.allSettled(targets.map(v => getJson(url(v.q, v.paged ? v.before : null), signal)));
    if (myGen !== gen) return null;
    let failures = 0, firstError = null;
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
        if (!firstError) firstError = r.reason;
      }
    });
    return { failures, firstError };
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
    const res = await fetchAll(variants, myGen, ctrl.signal);
    if (res === null) return null;
    if (res.failures === variants.length) {
      cur = null; ctrl = null;
      throw new Error((res.firstError && res.firstError.message) || String(res.firstError || 'search failed'));
    }
    next.failed = res.failures;
    cur = next;
    return state();
  }

  async function more() {
    const mine = cur;
    if (!mine || !ctrl) return { hits: [], hasMore: false, failed: 0, total: 0, query: '' };
    const targets = mine.variants.filter(v => v.more);
    if (!targets.length) return state();
    const myGen = gen;
    const res = await fetchAll(targets, myGen, ctrl.signal);
    if (res === null || mine !== cur) return null;
    mine.failed += res.failures;
    return state();
  }

  return { run, more, cancel };
}
