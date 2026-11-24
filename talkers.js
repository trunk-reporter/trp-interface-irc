// Pure helpers for the label of a call heard from several radios ("A, B +2").

/** Split a call's radios into the ones named in the label and the ones the "+N" stands for.
 *  `nameOf(unit)` gives a radio's nick. Duplicate units are dropped; order is kept. */
export function talkerParts(units, nameOf, max = 2) {
  const seen = new Set();
  const all = [];
  for (const u of units || []) {
    if (u == null || seen.has(u)) continue;
    seen.add(u);
    all.push({ unit: u, name: nameOf(u) });
  }
  return { shown: all.slice(0, max), hidden: all.slice(max), all };
}

/** The plain-text label: "A, B +2". */
export function talkersText(parts) {
  return parts.shown.map(p => p.name).join(', ') + (parts.hidden.length ? ` +${parts.hidden.length}` : '');
}
