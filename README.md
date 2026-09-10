# Youbefy

Chrome extension (Manifest V3) that converts a Spotify playlist into a YouTube
playlist. It adds a floating **Convert to YouTube** button to any
`open.spotify.com/playlist/*` page, reads the tracklist, finds a matching video
for each track, and builds the playlist on your YouTube account.

---

## Setup

You need your own Google OAuth client — the extension has no server and no
bundled credentials.

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
```

Note that `redirect_uri_mismatch` and `invalid_client` are different problems:
the first means the URI is unregistered, the second means the Client ID is wrong.
A newly created OAuth client can also take a few minutes to propagate.

### Using it

1. Open a Spotify playlist page in the browser.
2. Click **Sign in with Google** if it appears (only needed once per token).
3. Click **Convert to YouTube**. It scrolls the playlist to load every track,
   then reports progress in the bottom-right panel.
4. When it finishes, the new YouTube playlist opens in a new tab.

---

## API quota — read this

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

## Changelog

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

Fixes through 0.2.1 are committed but **not yet verified against a live
conversion**. Setup reached the Google consent screen successfully — the
extension loads, the manifest key holds the ID, the redirect URI is accepted and
the Client ID is correct — but end-to-end testing is paused waiting on billing to
clear in Google Cloud.

To pick it up from here:

1. Run `sync-to-test.ps1`, press **Reload** on the extension card.
2. Open a Spotify playlist and click **Sign in with Google**, then
   **Convert to YouTube**.
3. Start with a **short playlist (5-10 tracks)** — each track costs 50 quota
   units to insert, so a first run on a large playlist can burn the daily budget
   before revealing a bug.
4. Keep the **service worker** console open; auth and quota errors surface there.

The scroll-loop fix is the one most worth watching on a real playlist: that path
was terminating early, so confirm the "found N" count matches the playlist's
actual length before the conversion starts.

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
- **No tests** and no build step.
