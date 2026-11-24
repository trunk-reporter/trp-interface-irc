# Name colors, talkgroup popup editing, Options dialog

Hand-off notes for whoever reviews or extends this (a person or an AI assistant). Everything is in `index.html`
(one module script), as the rest of this interface is. No new files besides this note; no build step.

Branch `feat/colors-and-options`, stacked on `global-search` (transcript search + talkers label), which is stacked on
`mobile` (PR #3), which is stacked on `pr/tree-unread-name-sync` (PR #2). The commits after `7384ecd` are
the new work, in order. Each one passes a syntax check of the page's script; only the tip was loaded in a browser.

## What it adds, one commit each

| Commit | Change |
|---|---|
| Starred section: fold | The Starred tree group folds like Unread/Ignored. Key `irc_fav_collapsed`. |
| Channel name colors | Per-channel color for a channel's name, browser-local. Key `irc_chan_colors` (`"system:tgid"` -> `#rrggbb`). Fire talkgroups default red, law blue (`autoChanColor`, from the talkgroup file's Tag; fallback FD / PD in the name). |
| Talkgroup details popup | Click the channel name in the channel bar: `openTgModal`. Reuses the unit popup's CSS (`.unit-modal*`). |
| Popup: edit name, description, tag, group | `buildTgField` (text), `buildTgSelect` (dropdown of values in use + "+ Add new..." with `prompt` then `confirm`), `pickList`, `writeField`. Enter or blur saves, Escape reverts. Also swaps the swatches for the IBM Carbon categorical palette. |
| Swatches follow light/dark themes | `CHAN_PALETTE_LIGHT` / `CHAN_PALETTE_DARK`, same slot order. `isDarkTheme()` reads `--bg`. `resolveSavedColor()` maps a saved palette hex to the same slot of the current set. A `themechange` listener redraws. |
| Options dialog + colors by tag | `openOptions`, title-bar `#opts-btn`, and the phone ⋯ sheet. Tag colors: `irc_tag_colors` (lower-cased tag -> hex), `explicitTagColor`, `chanTagColor`, `buildTagColorControls`. |
| Options: transcript server, back up / move, folding | `optSection` (state in `irc_opts_<id>_open`), `fillColorsSection`, `fillTranscriptSection`, `fillBackupSection`, `exportSettings`, `parseSettingsFile`, `SETTINGS_KEY` / `SETTINGS_SKIP`. |
| README | Documents the above. |

## Behaviour worth knowing

- **Color precedence** (`getChanColor`): the channel's own color, then its tag's color, then the automatic fire/law color.
  The channel's "Reset" falls back to the next one ("Use tag color" / "Back to auto").
- **Palette slots, not hexes.** A saved swatch is stored as its hex but shown as the same *slot* of whichever set matches
  the current theme, so a choice follows a light/dark theme switch. Hexes outside both sets (the custom color picker, and
  colors saved by earlier versions) are shown as saved.
- **Recorder writes.** Name goes through `saveChannelTag` (kept in the browser, and sent with `setTalkgroup { alphaTag }`
  when Sync is on, as the existing pencil does). Description, tag and group go through `writeTalkgroup` with
  `{ description }`, `{ tag }`, `{ category }` (the client's `setTalkgroup` edit takes `alphaTag, description, tag, category,
  ignore`). They need control access **and** Sync on (`syncOn()`); otherwise the boxes are disabled with a note. The
  popup redraws on the recorder's `talkgroupEdited` (skipped while one of its boxes has focus).
- **"Add new..." writes a new tag/group value** into that talkgroup's cell, so it shows up in the list for every
  talkgroup from then on. It asks twice (the value, then a confirmation) because that edits the recorder's file.
- **Back up / move settings** exports every key matching `SETTINGS_KEY` (`irc_*`, `irc-*`, `nerd_mode`, `op_patterns`,
  `trp-theme`) except `irc_transcribe` (the transcript address is per machine). Import validates the file
  (`app: "trp-interface-irc"`, string values, keys matching the pattern), asks for confirmation, writes the keys and
  reloads. Unknown keys in a file are ignored.
- **Transcript server** field is the same setting as `/api http://host:port` (`irc_transcribe`, `cleanHttpBase`,
  `connectTranscripts`). The default is still the page's own host on port 8767.
- Everything above is browser-local except the recorder writes in the popup.

## What was tested, and what was not

- `node --test test/*.mjs`: 35 pass (the existing unread, talkers and search tests). The new functions live inside
  `index.html`, so they have no unit tests yet; `resolveSavedColor`, `parseSettingsFile` and `isDarkTheme` are pure and
  would be easy to move into a small module (like `unread.js`, `talkers.js`, `search.js`) with tests, if you want that.
- Headless Chrome (puppeteer) against a live recorder, tip only: the page loads without page errors;
  the popup, both palettes on a light and a dark theme, tag coloring, folding sections, and settings import (a good key
  applied; the transcript address and an unknown key ignored) behave as described.
- **Not exercised against a live recorder:** saving name/description/tag/group from the popup, and "+ Add new...".
  Those reuse the existing `writeTalkgroup` / `saveChannelTag` paths, but nobody has clicked Save on them yet.
- Not tested: landscape phone layout; the Options dialog on a phone beyond the menu entry.

## Things the maintainer may want to decide

1. **Where to land it.** It is large (~650 added lines over search). It could be split: Starred fold, channel colors +
   popup, popup editing, Options. The commits are in dependency order, but only the tip has been run in a browser.
2. **Version / `interface.json`.** Not bumped.
3. **Control access.** Popup editing and the sync features need an interface with control access. With listen access the
   boxes are disabled and the name stays in the browser, as before.
4. **No setup-specific code.** Nothing refers to a particular host, port, or agency. The automatic fire/law colors read the
   talkgroup file's Tag ("Fire...", "Law..."), which is the RadioReference naming.

## Running it

Copy `index.html` (plus the `.js` files beside it) into an interface folder as usual; no build. To check the layout
in a browser without a recorder, the recorder client library (`/api/client.js`) must be reachable, so run it from a
recorder-served interface port.
