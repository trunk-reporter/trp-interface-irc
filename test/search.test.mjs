import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery, mergeHits, safeSnippet } from '../search.js';

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
