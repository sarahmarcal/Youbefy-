# Youbefy

Chrome extension (Manifest V3) that converts a Spotify playlist into a YouTube
playlist. It adds a floating **Convert to YouTube** button to any
`open.spotify.com/playlist/*` page, reads the tracklist, finds a matching video
for each track, and builds a YouTube playlist from them — either a temporary one
with no setup at all (**free mode**, the default) or a real playlist on your
YouTube account (**API mode**).

---

## Setup

### Free mode (no Google Cloud)

Needs zero setup: no Google account, no Cloud project, no OAuth client, no API
quota. It is the default; nothing has to be entered in the options page.

Videos are found by scraping `youtube.com/results`, and the matches are handed
to YouTube's own `watch_videos?video_ids=…` endpoint, which redirects to an
anonymous playlist (`list=TLGG…`). What you get:

- A playlist that plays in order on a normal watch page, with loop and shuffle.
- **It is temporary.** The list ID encodes the date it was made, it is titled
  "Untitled List", and it is not saved anywhere on your account. Signed out,
  YouTube shows no option to save the list as a whole — only **Save to playlist**
  on individual videos. To keep it, save the videos you want one by one, or use
  API mode.
- **At most 50 videos per list.** Anything past the 50th id is silently dropped
  by YouTube (measured, see `buildWatchVideosUrls` in `background.js`), so longer
  playlists open as several tabs, one per 50 tracks.

Limits: no playlist name or privacy setting, and it depends on YouTube's HTML and
the undocumented `watch_videos` endpoint — either could change without notice.
Lookups pause ~300 ms between searches to avoid being throttled, so a 200-track
playlist takes a minute or two.

### API mode (your own Google OAuth client)

Pick **YouTube account** under *Mode* in the options page. You need your own
Google OAuth client — the extension has no server and no bundled credentials.
Neither the YouTube Data API nor an OAuth client in *Testing* requires a billing
account or free-trial activation in Google Cloud.

1. **Google Cloud Console** → create (or pick) a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** → configure it. While it is in
   *Testing*, add your own Google account under **Test users**, or sign-in will
   be rejected.
4. **APIs & Services → Credentials** → *Create credentials* → **OAuth client ID**
   → application type **Web application**. It must be this type; the *Chrome
   Extension* type has no redirect URI field.
5. In that client, under **Authorized redirect URIs**, add:

   ```
   https://khkddicldodofidklleknlgokhkchbei.chromiumapp.org/oauth2
   ```

   Leave **Authorized JavaScript origins** empty — see *OAuth troubleshooting*.
6. Copy the **Client ID** with the copy button next to it (not by selecting the
   text). Paste it into the extension's options page, pick a default playlist
   privacy, and hit **Save**.

The redirect URI is fixed because `manifest.json` carries a `key` field pinning
the extension ID to `khkddicldodofidklleknlgokhkchbei`. Without it the ID is
derived from the load path, so every move meant a new ID, a new redirect URI,
and another trip to Cloud Console. The matching private key lives in
`youbefy-key.pem`, which is gitignored and only needed to pack a `.crx` — not to
load unpacked. Do not commit or share it.

### Loading the extension

`chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select
`C:\Youbefy` (not this folder — see below).

> **Known environment issue:** loading from a path containing accented
> characters (this project lives under `sarú/programação/`) fails silently — the
> extension never appears in the list.

Run `sync-to-test.ps1` to mirror the project to `C:\Youbefy` and load *that*
folder. Re-run it after every edit, then press **Reload** on the extension card;
Chrome reads the copy, not this directory. The pinned key means the mirrored
copy keeps the same extension ID, so the OAuth registration survives.


   ```
### OAuth troubleshooting

Two failures cost real time during first setup, both with misleading messages:

| Symptom | Cause |
|---|---|
| `Origem inválida: não é permitido que URIs de origem contenham um caminho` | The redirect URI was pasted into **Authorized JavaScript origins**, which takes a scheme and host only. It belongs in **Authorized redirect URIs**, a separate block further down. Youbefy needs no JavaScript origin at all — `launchWebAuthFlow` is not a browser-page request. |
| `Error 401: invalid_client` / `The OAuth client was not found` | The stored Client ID was truncated — only the leading digits (which are also the project number) got copied. A full ID is ~70–75 chars and ends in `.apps.googleusercontent.com`. Use the copy button rather than selecting by hand. |

To inspect what is actually stored, open the **service worker** console from the
extension card and run:

```js
chrome.storage.sync.get(['googleClientId'], (r) => {
  const id = r.googleClientId || '';
  console.log('length:', id.length, '| shape ok:',
    /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id));
});


Note that `redirect_uri_mismatch` and `invalid_client` are different problems:
the first means the URI is unregistered, the second means the Client ID is wrong.
A newly created OAuth client can also take a few minutes to propagate.
```
### Using it

1. Open a Spotify playlist page in the browser.
2. API mode only: click **Sign in with Google** if it appears (only needed once
   per token). Free mode never shows it.
3. Click **Convert to YouTube**. It scrolls the playlist to load every track,
   then reports progress in the bottom-right panel.
4. When it finishes, the playlist opens in a new tab (free mode: one tab per 50
   tracks, the first one focused).

---

## API quota — read this

This section applies to API mode only; free mode uses no API quota.

The YouTube Data API gives a project **10,000 quota units per day** by default.
The costs that matter:

| Operation | Cost | Notes |
|---|---|---|
| `search.list` | **100** units | Finding a video for a track |
| `playlistItems.insert` | **50** units | Adding one video to the playlist |
| `playlists.insert` | **50** units | Once per conversion |

Originally every track cost 150 units (search + insert), so a 100-track playlist
consumed 15,050 units — **over the entire daily quota for a single playlist**.

Two mitigations are now in place:

- **Free video lookup.** Video IDs are resolved by fetching
  `youtube.com/results` and parsing the response, which costs **0** quota. The
  official `search.list` is used only when that fails.
- **Persistent cache.** Every resolved `title + artist → videoId` pair is stored
  in `chrome.storage.local` (capped at 2000 entries), so re-running a conversion
  or converting overlapping playlists costs nothing extra for known tracks.

That brings a 100-track playlist down to roughly **5,050 units** — the
`playlistItems.insert` cost, which the API gives no way to avoid or batch. So
expect **~2 large playlists per day** on the default quota. Request a quota
increase in Cloud Console if you need more.

The free lookup depends on YouTube's HTML shape and will break if they change
it; when it does, the extension falls back to the paid endpoint automatically
and you will hit the old limits again.

---
```
## Changelog

### 0.3.0 — free mode

**Free mode (new default)**
- New `mode` setting (`chrome.storage.sync`): `"free"` or `"api"`, unset means
  free. Selectable in the options page; the Client ID and privacy fields are
  dimmed while free mode is selected.
- Free mode resolves tracks with the cache and `scrapeVideoId()` only — no
  sign-in, no `playlists.insert`, no `search.list` fallback — and builds
  temporary playlists via `watch_videos?video_ids=…`, 50 ids per URL.
- Network scrapes are spaced ~300 ms apart; cache hits are not delayed. Cache
  semantics are unchanged (hits kept, misses expire after 7 days, a thrown lookup
  is not a miss, cache saved in `finally`).
- The content script skips the silent sign-in and keeps the sign-in button
  hidden in free mode, and follows mode changes without a page reload.

**Both modes**
- The result is opened by the background with `chrome.tabs.create` instead of
  `window.open` in the content script. After minutes of async work there is no
  user gesture left, so `window.open` could be popup-blocked — this affected the
  API-mode playlist tab too.

**Track scraping — found in the first live run in Chrome**
- `findScroller()` picked the first `[data-overlayscrollbars-viewport]`, which is
  the left *Your Library* sidebar, so the sidebar scrolled and the playlist did
  not: a 50-track playlist yielded 23 tracks. It now walks up from a tracklist
  row first, and only falls back to viewports that contain a row.
- Rows were matched with `[role="row"]` too, which includes the column header,
  so a track named "Title" was scraped first. Only
  `[data-testid="tracklist-row"]` is read now.
- Reaching the bottom no longer ends the scroll immediately. Spotify loads rows
  in pages, and on a fresh page load that cut the playlist at 13. The loop now
  waits longer and stops only after three passes with nothing new. It also waits
  up to 10 s for the first row to mount.
- `getPlaylistName()` read the first `h1` in the document — again the sidebar's
  "Your Library". It now reads `[data-testid="entityTitle"]` / `main h1`.
- Verified on a 50-track playlist: "Found 50 tracks".

**Video lookup**
- `scrapeVideoId()` returned `null` on any non-2xx response, which the caller
  recorded as a confirmed miss — a throttled request was cached as "no video"
  for 7 days. It now throws unless it received a real results page, and returns
  `null` only when that page has no `videoRenderer`.
- Dropped the bare `"videoId"` fallback regex; it matched unrelated player
  config and could pick an arbitrary video.
- Free mode retries a failed lookup once after 2 s (YouTube briefly answers
  bursts of searches with a redirect loop) and logs
  `[youbefy] lookup failed: <query> <reason>` to the service worker console.

**Tooling**
- `tests/run.mjs`: zero-dependency Node harness — `node tests/run.mjs`, or
  `--offline` to skip the live YouTube checks. See `tests/README.md`.
- `sync-to-test.ps1` exits 0 on robocopy's success codes (1–7) instead of
  leaking them as a failure.

**Docs**
- Corrected *Where this stands*: API mode does not need billing.
- Added `CLAUDE.md` with working notes for AI-assisted sessions.

### 0.2.1 — cache correctness, scroll termination, pinned ID

**Video-ID cache**
- Misses are stored as `{ miss: timestamp }` with a 7-day TTL instead of a bare
  `null`. Previously a miss was indistinguishable from a hit-of-nothing and was
  never re-checked, so a track that failed once was cached as a permanent
  no-match.
- A lookup that *threw* is no longer recorded as a miss at all. Only a lookup
  that completed and genuinely found nothing counts, so a network blip no longer
  poisons the entry.
- Bare `null`s written by 0.2.0 are read as absent, so existing caches heal on
  their own — no wipe needed.
- The resolve loop is wrapped in `try/finally` so the cache is persisted even
  when a run dies partway. A quota failure is exactly the case where the next
  attempt most needs it; previously that run's lookups were all discarded.

**Track scraping**
- `scrapeAllTracks()` bottom-detection compared `seen.size` against a `lastCount`
  assigned two lines earlier, so the condition was always true and the loop bailed
  on the first pass where the scroller did not move — the opposite of the
  three-stagnant-pass rule the comment described. Movement and growth are now
  tracked separately.

**Messaging**
- `CONVERT_PLAYLIST` acknowledges immediately instead of holding a message port
  open across a conversion that runs for minutes. The outcome already ships via
  `tabs.sendMessage`.

**Packaging**
- `manifest.json` carries a `key` pinning the extension ID, so the OAuth redirect
  URI no longer changes when the folder moves.
- Added `sync-to-test.ps1`.
- The project is now a git repository.

### 0.2.0 — bug-fix pass

**Quota**
- Video lookup now scrapes `youtube.com/results` (0 quota) with `search.list` as
  fallback, instead of spending 100 units on every single track.
- Added a persistent `videoIdCache` in `chrome.storage.local`.
- Quota-exceeded (HTTP 403) responses are now detected and reported as a clear
  message instead of a raw API error dump.

**Auth**
- Merged the two separate OAuth flows into one. Previously `ensureBasicAuth()`
  (openid/email/profile) and `ensureAccessToken()` (youtube) each opened their
  own consent popup, so converting a playlist meant two Google popups. Now a
  single request carries all four scopes.
- The silent sign-in attempt no longer forces `prompt=consent`; `prompt=none` is
  used for silent passes and `consent` only for interactive ones. Failures are
  handled quietly instead of logging an error on every fresh profile.

**Track scraping**
- `scrapeTracks()` only saw the ~30 rows the virtualized tracklist keeps mounted,
  so long playlists silently lost most of their tracks. Replaced with
  `scrapeAllTracks()`, which locates the scroll container, walks the full list
  collecting rows as they mount, then restores the original scroll position.
- Track cap raised from 100 to 200.
- Removed the dead no-op fallback block.

**UI**
- The sign-in button had no CSS at all and rendered as an unstyled default button
  at the top of the page. It is now styled and positioned above the convert
  button.
- Convert button disables itself while a conversion is running.
- The completion message reports how many tracks matched and how many did not,
  rather than just "Done!".
- Overlay is now built with DOM calls instead of `innerHTML`.

**Housekeeping**
- Renamed leftover `spotitube` / `SpotiTube` identifiers and log strings to
  `youbefy`.
- Added `https://www.youtube.com/*` to `host_permissions` (needed by the free
  lookup).
- Added `action.default_icon` to the manifest.

---

## Where this stands

First live free-mode run in Chrome (2026-10-29), on a 50-track playlist:

- **Spotify scraping works**: after the fixes above, "Found 50 tracks".
- **Video lookup is the open problem**: only 12 of 50 tracks matched inside the
  extension, while the same queries resolve from Node/curl (`tests/run.mjs`
  matched 12/12 known tracks). The cause is not known yet. Next step: reload
  the extension, open the **service worker** console, convert a short playlist
  and read the `[youbefy] lookup failed:` lines. If YouTube is blocking the
  extension's scrapes, API mode is the free fallback.

API-mode setup reached the Google consent screen successfully — the extension
loads, the manifest key holds the ID, the redirect URI is accepted and the
Client ID is correct. Testing was then paused "waiting on billing", but that was
not actually a blocker: billing / free-trial activation is not needed for the
YouTube Data API, and the default 10,000 units/day quota is free.

To pick it up from here:

1. Run `sync-to-test.ps1`, press **Reload** on the extension card.
2. Free mode first: open a Spotify playlist and click **Convert to YouTube**.
   Then try a playlist over 50 tracks and check it opens one tab per 50.
3. API mode: switch *Mode* in the options page, click **Sign in with Google**,
   then **Convert to YouTube**.
4. In API mode, start with a **short playlist (5-10 tracks)** — each track
   costs 50 quota units to insert, so a first run on a large playlist can burn
   the daily budget before revealing a bug.
5. Keep the **service worker** console open; auth and quota errors surface there.

Keep confirming that the "Found N tracks" count matches the playlist's actual
length before the conversion starts — Spotify's DOM changes and that path has
broken three different ways already.

## Known gaps / not yet done

- `asset/magnific_highfashion-indie-editori_y6lF5LZPW9.png` is unreferenced by
  any file. Either wire it up or delete it.
- **Implicit grant means no refresh token.** Tokens expire after ~1 hour and the
  next conversion opens an interactive popup. Moving to an auth-code + PKCE flow
  would fix this.
- **No fuzzy matching.** The query is a plain `"{title} {artist}"` string, so
  remixes, live versions, and covers can win over the intended track. There is no
  duration check against the Spotify metadata.
- **No resume.** If a conversion dies partway (quota, network), the partially
  filled YouTube playlist is left behind and a re-run creates a second one. The
  video-ID cache means the re-run is cheap, but the duplicate playlist is manual
  cleanup.
- **Tests cover `background.js` only.** `tests/run.mjs` exercises the cache,
  URL building and free-mode flow; the Spotify scraping in `contentScript.js`
  and the OAuth/API path still need a manual run in Chrome. No build step.
- **Cache eviction is FIFO, not LRU** — a hit is never moved to the back, so
  often-used entries are evicted first.
