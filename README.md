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
   → application type **Web application**.
5. Load the extension (below), open its **options page**, and copy the
   **Redirect URI** shown there. Paste it into the OAuth client's
   *Authorized redirect URIs* and save.
6. Back on the options page, paste the **Client ID**, pick a default playlist
   privacy, and hit **Save**.

### Loading the extension

`chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select
this folder.

> **Known environment issue:** loading from a path containing accented
> characters (this project lives under `sarú/programação/`) fails silently — the
> extension never appears in the list. Copy the folder to an ASCII-only path
> (e.g. `C:\Youbefy`) and load it from there, or move the project outright.

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
- Not a git repository.
