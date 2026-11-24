# Global transcript search (irc-v2) - short design

Status: approved by user 2026-11-19 ("do it").

## Intent and why
Brent wants to type something like `321 W 4th` in the IRC page and see every transmission that mentioned it, across all channels (systems/talkgroups), to follow an address or incident across channels.

## Goals
- Search box on the IRC page that searches all transcripts, not just channel names.
- Address-style queries find the spelling variants real transcripts contain.
- Each hit shows channel, time, speaker (if known), highlighted snippet; click jumps to the channel at that message; play button for audio.

## Non-goals / anti-goals
- No plugin change, no recorder restart (the plugin's `GET /api/v1/search` already exists).
- Must not break the existing channel-name filter (`tree-search`).
- Not a failure if some spoken forms ("three twenty-one") miss at first; rules get added as misses show up.

## Constraints (found in recon)
- Plugin search is FTS5, every word quoted and ANDed, no OR, `status='ok'` only. "W" never matches "West". Real text: `1216 West 4th`, `1331 west 4th street`, `2-8-1-1-westbound`, `one-thirty-west-sixty-fourth`.
- Response: `{hits:[{path,system,talkgroup,startMs,lengthMs,text,segments,snippet(<b>..</b>)}], more, before}`; paging by `before` (start_ms cursor).
- Page already has `fetchTranscribe()`, `TRANSCRIBE_BASE`, CORS origins for :8087.
- Single file `index.html` (+ small helper JS like `unread.js`, `talkers.js`, with `node --test` tests in `test/`).

## Approaches considered
1. Plain pass-through: smallest, misses W/West, 4th/Fourth, 3-2-1.
2. **Page-side query expansion (chosen):** expand query into likely spellings, send in parallel, merge by `path`, dedupe. No plugin work.
3. Normalize in plugin (index-time): most accurate, but patches/forks Auggie's plugin, reindex, restart. Possible later on top of 2.

## Design
- `search.js` (pure, unit-tested): `expandQuery(text) -> string[]` (max ~8 variants): direction letters N/S/E/W <-> north/south/east/west; ordinals `4th` <-> `fourth` (1-12 words, digits); street suffix St/Street/Ave/Avenue/Rd/Road/Dr/Drive/Blvd/Ln/Ct optional (try with and without); house number as `321` and digit-grouped `3-2-1`. `mergeHits(responses) -> hits` dedupes by `path`, sorts newest first.
- UI: Search panel separate from channel filter. Debounce 300 ms, Enter runs now, Esc clears. AbortController cancels stale requests. States: idle hint, loading, empty, error (plugin unreachable). "Load more" using per-variant `before` cursors.
- Hit row: channel name (via existing system/tg -> channel mapping), local time, speaker label, snippet with `<b>` highlights (sanitize: only allow `<b>`, escape rest), play button using existing audio playback. Click jumps to channel and scrolls to message if loaded, else shows it from the hit.
- Phone layout (<768px): panel reachable from top bar menu; full-width list.

## Left to the builder
Exact panel placement/styling, how jump-to-message works with the existing message buffers, which suffix/ordinal rules ship first.

## Deploy
Copy `index.html` (+ new `search.js`) to `/data/config/trunk-pro/interfaces/irc-v2/` with `docker cp`; keep rollback `index.html.bak-pre-search-2026-11-19`; deployed `interface.json` untouched.
