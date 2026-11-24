# Global Transcript Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Search panel on the irc-v2 page that finds transcripts across all channels, tolerating address spelling variants (`321 W 4th`).

**Architecture:** Pure helpers in a new `search.js` (query expansion, merge, snippet sanitizing, parallel fetch) unit-tested with `node --test`; a Search panel in `index.html` that calls them through the existing `fetchTranscribe()` and reuses `switchChannel()` / `playCall()`. No plugin or recorder change.

**Tech Stack:** Vanilla JS ES modules in one HTML page, `node --test` (Node v22 on host), transcribe plugin `GET /api/v1/search`.

**Spec:** `docs/superpowers/specs/2026-11-19-global-transcript-search-design.md`

## Global Constraints

- No plugin/recorder change; endpoint is `GET {TRANSCRIBE_BASE}/api/v1/search?q=&limit=&before=` returning `{hits,more,before}`; hit = `{path,system,talkgroup,startMs,lengthMs,text,segments:[{unit,start,end,text}],snippet}`.
- Plugin ANDs all words and has no OR: variants are separate requests merged client-side by `path`.
- Max 8 query variants per search; debounce 300 ms; Enter searches now; Esc clears.
- Existing channel filter (`#tree-search`) behavior unchanged.
- Snippet HTML: only `<b>`/`</b>` allowed, everything else escaped.
- Deploy: `docker cp` `index.html` + `search.js` to `/data/config/trunk-pro/interfaces/irc-v2/`; backup `index.html.bak-pre-search-2026-11-19`; do not touch deployed `interface.json`.
- Phone layout (<768 px) must work.

## Review Focus

- Query is only whitespace or only punctuation -> no request, idle state.
- Query contains `<script>` / `"` / `&` -> echoed and rendered escaped, no breakage.
- Slow response for an old query arrives after a newer one -> ignored.
- Plugin down / CORS failure / non-200 -> error state with message, not a blank list.
- Hit whose system/talkgroup has no channel yet (never loaded) -> still shown, click loads or creates the channel, no exception.
- A variant request fails while others succeed -> show partial results, not an error.
- Duplicate hits across variants -> one row.

---

### Task 1: Query expansion, merge, snippet sanitizer

**Files:**
- Create: `search.js`
- Test: `test/search.test.mjs`

**Interfaces:**
- Produces: `expandQuery(text: string): string[]` (original first, deduped, <= 8, `[]` if no word chars); `mergeHits(lists: Hit[][]): Hit[]` (dedupe by `path`, newest `startMs` first); `safeSnippet(html: string): string`.

- [ ] **Step 1: Write failing tests** in `test/search.test.mjs` (same style as `test/unread.test.mjs`):
  - `expandQuery('321 W 4th')` includes `'321 west 4th'`, `'321 west fourth'`, `'321 w fourth'`, and `'3-2-1 west 4th'`; first element is `'321 w 4th'` (lowercased original).
  - `expandQuery('1216 west fourth')` includes `'1216 west 4th'`.
  - `expandQuery('main street')` includes `'main'` and `'main st'` (suffix optional / abbreviated); `expandQuery('  ')` and `expandQuery('--')` return `[]`.
  - `expandQuery('a b c d e f g h i j')` length <= 8.
  - `mergeHits([[{path:'a',startMs:1},{path:'b',startMs:3}],[{path:'a',startMs:1}]])` yields paths `['b','a']`.
  - `safeSnippet('x <b>y</b> <script>1</script> & "q"')` equals `'x <b>y</b> &lt;script&gt;1&lt;/script&gt; &amp; &quot;q&quot;'`.
- [ ] **Step 2: Run** `node --test test/search.test.mjs` -> FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `search.js`. Rules: direction letters n/s/e/w <-> north/south/east/west; ordinals 1st-12th <-> first-twelfth; suffix st/street, ave/avenue, rd/road, dr/drive, blvd/boulevard, ln/lane, ct/court: add variants with suffix as written, swapped form, and dropped; a 1-4 digit number token also as digit-grouped `3-2-1`. Build variants by per-token alternatives, cross-product, cap 8 with the original and most-likely (full-word) forms kept first. `safeSnippet`: escape `& < > "` then restore `&lt;b&gt;`/`&lt;/b&gt;` to real tags.
- [ ] **Step 4: Run** the tests -> PASS.
- [ ] **Step 5: Commit** `feat(search): query expansion, merge, snippet sanitizer`.

### Task 2: Parallel search runner with cancel and paging

**Files:**
- Modify: `search.js`
- Test: `test/search.test.mjs`

**Interfaces:**
- Consumes: `expandQuery`, `mergeHits` (Task 1).
- Produces: `createSearch(getJson: (path: string, signal: AbortSignal) => Promise<object>, opts?: {limit?: number}): { run(text: string): Promise<SearchState>, more(): Promise<SearchState>, cancel(): void }` where `SearchState = { hits: Hit[], hasMore: boolean, failed: number, total: number, query: string }`. `run` throws nothing on partial failure; rejects with `Error` only when every variant failed. A call superseded by a newer `run`/`cancel` resolves to `null`.

- [ ] **Step 1: Write failing tests** with a fake `getJson`:
  - run sends one request per variant to `/api/v1/search?q=<encoded>&limit=<n>`; merged, deduped hits returned.
  - one variant rejects, others resolve -> `failed === 1`, hits present, no throw.
  - all reject -> `run` rejects.
  - second `run` started before first resolves -> first resolves `null` and its signal is aborted.
  - `more()` re-queries only variants whose last response had `more:true`, passing that variant's `before`; result appends and dedupes; `hasMore` false when none left.
  - whitespace query -> no requests, `{hits:[],hasMore:false,...}`.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** `createSearch` (one `AbortController` per `run`, per-variant cursor map). **Step 4: Run** -> PASS.
- [ ] **Step 5: Commit** `feat(search): parallel runner with cancel and paging`.

### Task 3: Search panel in index.html

**Files:**
- Modify: `index.html` (import near line 1401; markup next to `.tree-search` ~line 1286; CSS near `.tree-search` ~line 220; logic near the channel-search block ~line 1770)

**Interfaces:**
- Consumes: `createSearch`, `safeSnippet` (Tasks 1-2); existing `fetchTranscribe(path)` (index.html:4150, extend with optional `signal` param passed to `fetch`), `resolveChannel(systemId, tgid)` (:2826), `switchChannel(ch)` (:3700), `playCall(callId, nick, channel, msgEl, txPos, txDuration)` (:5436, `callId` = hit `path`), `esc()` (:3094).
- Produces: panel element `#search-panel`, input `#global-search`, list `#search-results`.

- [ ] **Step 1: Markup + CSS.** Add a "Search transcripts" input and a results container under the channel filter; collapsed until the input has text. Reuse existing theme variables; `font-size:16px` on the input at <768 px (as `.tree-search-input` does at :1163).
- [ ] **Step 2: Wire** `createSearch((p, s) => fetchTranscribe(p, s))`; 300 ms debounce on `input`, Enter runs immediately, Esc clears and cancels. Render states: idle hint, "Searching...", `No matches for "<esc(query)>"`, error text with the exception message, "N variant(s) failed" note when `failed > 0`, "Load more" button when `hasMore`.
- [ ] **Step 3: Render hits.** Row = channel name from `resolveChannel(system, talkgroup)` (fallback `system/talkgroup`), local time from `startMs`, snippet via `safeSnippet`, play button calling `playCall(path, null, channel, null, null, null)`. Click row: if the channel exists `switchChannel(name)`; if not, show the hit text in the row only (no channel creation) - builder confirms what `lazyLoadChannel` needs before adding creation.
- [ ] **Step 4: Manual check against live :8087 copy** (Task 4 deploy to a scratch dir is not needed; open index.html via the real interface after deploy): search `321 W 4th`-style known text such as `1216 west 4th`; confirm hits from more than one channel, play works, click switches channel, Esc clears, old tree filter still filters.
- [ ] **Step 5: Run** `node --test test/*.mjs` -> PASS. **Commit** `feat(search): global transcript search panel`.

### Task 4: Phone layout and deploy

**Files:**
- Modify: `index.html` (phone CSS block ~line 1163; `#menu-sheet` ~line 1366), `tools/mobile-layout.cjs` (add a check that `#global-search` is visible and full width at 390 px)

**Interfaces:**
- Consumes: Task 3 elements.

- [ ] **Step 1:** Phone: add a "Search transcripts" row in `#menu-sheet` that opens the panel full-width; results list scrolls, rows min 44 px tall.
- [ ] **Step 2: Run** `tools/mobile-layout.cjs` as in memory notes (zenika/alpine-chrome:with-puppeteer, `--network host`, http://127.0.0.1:8087/ after deploy) -> no horizontal overflow, search visible.
- [ ] **Step 3: Deploy:** `docker exec trunk-pro cp` backup of `index.html` to `index.html.bak-pre-search-2026-11-19`, then `docker cp index.html` and `docker cp search.js` into `trunk-pro:/data/config/trunk-pro/interfaces/irc-v2/`. Reload browser; run the Task 3 manual check on :8087.
- [ ] **Step 4: Commit** `feat(search): phone layout`.

## Self-Review

Spec coverage: expansion (T1), merge/dedupe (T1-2), cancel/states/paging (T2-3), hit row + jump + play (T3), phone (T4), deploy/rollback (T4). Types consistent: `Hit`, `SearchState`, `createSearch` used identically in T2/T3. Open builder call: click on a hit whose channel is not loaded (spec "left to the builder").
