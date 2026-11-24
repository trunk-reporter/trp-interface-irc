import { test } from 'node:test';
import assert from 'node:assert/strict';
import { talkerParts, talkersText } from '../talkers.js';

const name = u => `N${u}`;

test('talkerParts: two radios are all shown, nothing hidden', () => {
  const p = talkerParts([1, 2], name);
  assert.deepEqual(p.shown.map(x => x.unit), [1, 2]);
  assert.equal(p.hidden.length, 0);
  assert.equal(talkersText(p), 'N1, N2');
});
test('talkerParts: the rest go behind +N and stay reachable', () => {
  const p = talkerParts([1, 2, 3, 4], name);
  assert.deepEqual(p.hidden.map(x => x.unit), [3, 4]);
  assert.deepEqual(p.all.map(x => x.name), ['N1', 'N2', 'N3', 'N4']);
  assert.equal(talkersText(p), 'N1, N2 +2');
});
test('talkerParts: duplicates and missing units are dropped, order kept', () => {
  const p = talkerParts([5, 5, null, 6, undefined, 5, 7], name);
  assert.deepEqual(p.all.map(x => x.unit), [5, 6, 7]);
  assert.equal(talkersText(p), 'N5, N6 +1');
});
test('talkerParts: empty or missing input', () => {
  assert.equal(talkersText(talkerParts([], name)), '');
  assert.equal(talkersText(talkerParts(undefined, name)), '');
});
