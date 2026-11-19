import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery, mergeHits, safeSnippet, createSearch } from '../search.js';

test('expandQuery: address with direction, ordinal and house number', () => {
  const v = expandQuery('321 W 4th');
  assert.equal(v[0], '321 w 4th');
  for (const e of ['321 west 4th', '321 west fourth', '321 w fourth', '3-2-1 west 4th']) assert.ok(v.includes(e), e);
});
test('expandQuery: spelled-out ordinal gets numeric form', () => {
  assert.ok(expandQuery('1216 west fourth').includes('1216 west 4th'));
});
test('expandQuery: street suffix optional or abbreviated', () => {
  const v = expandQuery('main street');
  assert.ok(v.includes('main'));
  assert.ok(v.includes('main st'));
});
test('expandQuery: no word characters gives []', () => {
  assert.deepEqual(expandQuery('  '), []);
  assert.deepEqual(expandQuery('--'), []);
});
test('expandQuery: capped at 8, deduped, original first', () => {
  const v = expandQuery('a b c d e f g h i j');
  assert.ok(v.length <= 8);
  assert.equal(v[0], 'a b c d e f g h i j');
  assert.equal(new Set(v).size, v.length);
});
test('mergeHits: dedupe by path, newest first', () => {
  const m = mergeHits([[{ path: 'a', startMs: 1 }, { path: 'b', startMs: 3 }], [{ path: 'a', startMs: 1 }]]);
  assert.deepEqual(m.map(h => h.path), ['b', 'a']);
});
test('safeSnippet: keeps <b>, escapes everything else', () => {
  assert.equal(safeSnippet('x <b>y</b> <script>1</script> & "q"'),
    'x <b>y</b> &lt;script&gt;1&lt;/script&gt; &amp; &quot;q&quot;');
});
test('expandQuery: edge punctuation does not defeat expansion', () => {
  const v = expandQuery('321 W. 4th St.');
  assert.equal(v[0], '321 w. 4th st.');
  assert.ok(v.includes('321 west fourth street'));
  assert.deepEqual(expandQuery('. , --'), []);
});
test('expandQuery: huge input stays fast and bounded', () => {
  const q = Array.from({ length: 5000 }, (_, i) => 'w' + (i % 7)).join(' ');
  const t = performance.now();
  const v = expandQuery(q);
  assert.ok(v.length <= 8);
  assert.ok(performance.now() - t < 200);
});

// ---- createSearch ----
const hit = (path, startMs) => ({ path, startMs });
const qOf = p => decodeURIComponent(/[?&]q=([^&]*)/.exec(p)[1]);
const beforeOf = p => { const m = /[&?]before=([^&]*)/.exec(p); return m ? Number(m[1]) : undefined; };

test('createSearch: one request per variant, merged and deduped', async () => {
  const calls = [];
  const getJson = async (path) => {
    calls.push(path);
    const q = qOf(path);
    return { hits: q === 'main street' ? [hit('a', 3), hit('b', 1)] : [hit('a', 3), hit('c', 2)], more: false, before: 0 };
  };
  const s = await createSearch(getJson, { limit: 10 }).run(' main street ');
  const variants = expandQuery('main street');
  assert.equal(calls.length, variants.length);
  for (const v of variants) assert.ok(calls.includes(`/api/v1/search?q=${encodeURIComponent(v)}&limit=10`), v);
  assert.deepEqual(s.hits.map(h => h.path), ['a', 'c', 'b']);
  assert.equal(s.total, 3);
  assert.equal(s.failed, 0);
  assert.equal(s.hasMore, false);
  assert.equal(s.query, 'main street');
});

test('createSearch: default limit is 30', async () => {
  const calls = [];
  await createSearch(async (p) => { calls.push(p); return { hits: [], more: false, before: 0 }; }).run('fire');
  assert.ok(calls[0].endsWith('&limit=30'));
});

test('createSearch: partial failure counted, no throw', async () => {
  const getJson = async (path) => {
    if (qOf(path) === 'main') throw new Error('boom');
    return { hits: [hit('x', 1)], more: false, before: 0 };
  };
  const s = await createSearch(getJson).run('main street');
  assert.equal(s.failed, 1);
  assert.deepEqual(s.hits.map(h => h.path), ['x']);
});

test('createSearch: all variants failing rejects', async () => {
  await assert.rejects(createSearch(async () => { throw new Error('down'); }).run('main street'), Error);
});

test('createSearch: newer run supersedes older (null + abort)', async () => {
  const signals = [];
  const pending = [];
  const getJson = (path, signal) => new Promise((resolve) => { signals.push(signal); pending.push(() => resolve({ hits: [hit('old', 1)], more: false, before: 0 })); });
  const s = createSearch(getJson);
  const first = s.run('fire');
  const firstSignals = signals.slice();
  const second = s.run('police');
  assert.ok(firstSignals.every(x => x.aborted));
  pending.forEach(f => f());
  assert.equal(await first, null);
  const st = await second;
  assert.equal(st.query, 'police');
});

test('createSearch: cancel resolves in-flight run to null and aborts', async () => {
  let sig;
  const s = createSearch((p, signal) => new Promise((res, rej) => { sig = signal; signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))); }));
  const r = s.run('fire');
  s.cancel();
  assert.equal(sig.aborted, true);
  assert.equal(await r, null);
});

test('createSearch: more() re-queries only variants with more, using their before cursor', async () => {
  const calls = [];
  const getJson = async (path) => {
    calls.push(path);
    const q = qOf(path), b = beforeOf(path);
    if (q === 'main street') return b === undefined ? { hits: [hit('a', 10), hit('b', 9)], more: true, before: 9 } : { hits: [hit('b', 9), hit('c', 8)], more: false, before: 8 };
    return { hits: [hit('a', 10)], more: false, before: 0 };
  };
  const s = createSearch(getJson, { limit: 2 });
  const first = await s.run('main street');
  assert.equal(first.hasMore, true);
  calls.length = 0;
  const next = await s.more();
  assert.equal(calls.length, 1);
  assert.equal(qOf(calls[0]), 'main street');
  assert.equal(beforeOf(calls[0]), 9);
  assert.deepEqual(next.hits.map(h => h.path), ['a', 'b', 'c']);
  assert.equal(next.hasMore, false);
  calls.length = 0;
  const again = await s.more();
  assert.equal(calls.length, 0);
  assert.equal(again.hits.length, 3);
});

test('createSearch: whitespace query makes no requests', async () => {
  let n = 0;
  const s = await createSearch(async () => { n++; return { hits: [], more: false, before: 0 }; }).run('   ');
  assert.equal(n, 0);
  assert.deepEqual(s, { hits: [], hasMore: false, failed: 0, total: 0, query: '' });
});

test('createSearch: more() after cancel() sends no request', async () => {
  let n = 0;
  const s = createSearch(async () => { n++; return { hits: [hit('a', 1)], more: true, before: 1 }; });
  await s.run('fire');
  n = 0;
  s.cancel();
  await s.more();
  assert.equal(n, 0);
});

test('createSearch: more() during in-flight run() sends no request and leaves new state alone', async () => {
  let n = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const getJson = async (path) => {
    n++;
    if (qOf(path) === 'police') { await gate; return { hits: [hit('p', 1)], more: false, before: 0 }; }
    return { hits: [hit('a', 1)], more: true, before: 1 };
  };
  const s = createSearch(getJson);
  await s.run('fire');
  const second = s.run('police');
  n = 0;
  await s.more();
  assert.equal(n, 0);
  release();
  const st = await second;
  assert.equal(st.query, 'police');
  assert.equal(st.failed, 0);
});

test('createSearch: more() after an all-fail run sends no request', async () => {
  let fail = false, n = 0;
  const s = createSearch(async () => { n++; if (fail) throw new Error('x'); return { hits: [hit('a', 1)], more: true, before: 1 }; });
  await s.run('fire');
  fail = true;
  await assert.rejects(s.run('police'));
  n = 0;
  await s.more();
  assert.equal(n, 0);
});
