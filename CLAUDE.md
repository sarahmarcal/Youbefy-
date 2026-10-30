# Youbefy — notes for Claude

Chrome MV3 extension: Spotify playlist page → YouTube playlist. No build step,
no dependencies. User-facing docs live in `README.md`; this file is for working
on the code. The user is Brazilian — reply in Portuguese; code, comments and
README stay in English.

## Layout

- `background.js` — service worker. Classic script with top-level `function`
  declarations (no imports/exports) so `tests/run.mjs` can load it in `node:vm`.
  Keep it that way.
- `contentScript.js` — runs on `open.spotify.com/playlist/*`: injects the
  buttons/overlay, scrolls the virtualized tracklist, sends `CONVERT_PLAYLIST`.
- `options.html` / `options.js` — mode, OAuth Client ID, playlist privacy.
- `site/index.html` — marketing/landing page (download, modes, pricing, FAQ). Standalone, no build; loads `../icons/`, so open it from `site/`.
  Its `:root` CSS variables mirror the Figma tokens — keep the names in sync.
- `tests/run.mjs` — zero-dependency harness. `node tests/run.mjs` (live, hits
  youtube.com) or `--offline`. Run `--offline` after every background.js change.

## Two modes (`chrome.storage.sync` key `mode`, unset = `"free"`)

- **free** — `scrapeVideoId` (youtube.com/results, 0 quota) →
  `buildWatchVideosUrls` → `watch_videos?video_ids=...`, an anonymous temporary
  `TLGG…` playlist. YouTube silently keeps only the first **50** ids per URL
  (measured 2026-10-29), so results are chunked into several tabs. No way found
  to save a TLGG list as a real playlist.
- **api** — OAuth implicit grant via `launchWebAuthFlow` + YouTube Data API v3.
  Scrape first, `search.list` (100 units) only as fallback; `playlistItems.insert`
  is 50 units/track. The API and an OAuth client in Testing mode need **no
  billing account** — the 10,000 units/day quota is free.

`buildWatchVideosUrls(videoIds, chunkSize = 50)` is tested by name — don't
change its signature. Result tabs open from the background via
`chrome.tabs.create` (a `window.open` after the async round-trip gets
popup-blocked).

## Invariants that have bitten before

- **Cache** (`videoIdCache` in `storage.local`): a hit is a string; a confirmed
  no-match is `{ miss: ts }` with a 7-day TTL; anything else reads as absent.
  `scrapeVideoId` returns `null` *only* for a real results page with no
  `videoRenderer`; throttles, non-2xx and non-results pages must **throw** so
  they are never cached as misses. Don't reintroduce the bare `"videoId"`
  fallback regex — it matches unrelated player config.
- **Spotify DOM** (verified in Chrome on a 50-track playlist):
  - the "Your Library" sidebar is also an `[data-overlayscrollbars-viewport]`
    and comes first — find the scroller by walking up from a
    `[data-testid="tracklist-row"]`;
  - bare `[role="row"]` matches the column header ("Title");
  - the first `h1` is the sidebar's — use `[data-testid="entityTitle"]` / `main h1`;
  - rows load in pages, so reaching the bottom is not the end: wait and retry
    (three stagnant passes) before stopping.
- **YouTube throttles bursts**: after ~10 rapid searches it briefly answered
  with a redirect loop (see "Bot check" below). Free mode spaces scrapes 1 s
  and retries non-redirect failures once after 2 s. Don't try to defeat bot detection (UA spoofing etc.) — that was refused.

## Testing in Chrome

- Chrome silently fails to load unpacked extensions from paths with accents
  (this repo is under `sarú\programação`). Run `.\sync-to-test.ps1` (mirrors to
  `C:\Youbefy`), then **Reload** the Youbefy card. The `key` in `manifest.json`
  pins the ID `khkddicldodofidklleknlgokhkchbei`, which the OAuth redirect URI
  depends on — never touch it. `youbefy-key.pem` is gitignored; never commit it.
- Browser automation (claude-in-chrome) cannot open `chrome://extensions`, so
  the user has to press Reload. It also cannot see the service-worker console —
  ask the user to open it ("service worker" link on the card); free-mode lookup
  failures log as `[youbefy] lookup failed: <query> <reason>`.
- Good test playlist: Today's Top Hits,
  `open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M` (50 tracks). Confirm the
  overlay's "Found N tracks" matches the playlist length.

## Bot check (found 2026-10-29)

Free mode matched only 12/50 in Chrome because YouTube redirected the scrapes
to `google.com/sorry` (CAPTCHA); `fetch` saw only a CORS error. `scrapeVideoId`
now fetches with `redirect: "manual"` and throws `{ blocked: true }` on any
redirect. Free mode then stops at once (no retry; partial result, or an error
if nothing matched). Api mode switches to `search.list` for the rest of the run.
Scrapes are spaced 1 s apart. Don't try to solve or evade the CAPTCHA.

## Design (Figma)

File "Youbefy — Screens & Design System":
`figma.com/design/DDOa44YiV0MANoyn4tswJ4`. Pages:

- **Design System** — variable collection "Youbefy Tokens" (`color/*`,
  `radius/*`, `space/*`), text styles, `Shadow/Floating` / `Shadow/Overlay`,
  `Gradient/Brand 135°` (buttons) and `90°` (progress). Components: Button
  (Primary/Secondary), Progress Overlay, Progress Bar, Save Button, Input,
  Select, Code Chip, Form Field, Tag, Card. Values come from the CSS in
  `contentScript.js` / `options.html`; change both sides together.
- **Screens** — 01–07 Spotify page states (idle, sign-in, loading, searching,
  done free/api, error), 08–10 options page (free, api, Saved!).
- **Landing Page** — mirrors `site/index.html`. Unfinished: only nav + hero
  are built; a broken partial "How it works" section may be left from a failed
  call, so remove it first.

The user's Figma plan is Starter: the MCP call limit is low and was hit
mid-build. Batch as much as possible per `use_figma` call.

Known UI bug shown in screens 03–07: the overlay panel (`inset: 16px`,
bottom-right) sits under the Convert button (`bottom/right: 24px`, higher
z-index), hiding the end of the message. Not fixed yet.

## Site & business model

- `main`'s site must describe only what the extension does today: free,
  unlimited conversions, plus an optional one-time $4.99 **Supporter** tip
  (placeholder price). All checkout/download links are `#` placeholders.
- A planned per-playlist model (Free 1/day, Unlimited $4.99, "buy me a coffee"
  $1 = +1 bonus playlist) lives on the local branch `landing-page`. Keep it off
  `main` until the extension enforces it — that needs a backend
  (accounts/licenses + payments) plus a check in `background.js`; a local-only
  counter would be trivially bypassed.
- Don't use `asset/magnific_*.png` on the site — it shows a Nike logo
  (implied endorsement). The footer carries a "not affiliated with Spotify or
  YouTube" notice; keep it.

## Known gaps

Implicit grant has no refresh token (re-consent ~hourly); no fuzzy/duration
matching; no resume (a failed api-mode run leaves a partial playlist); cache
eviction is FIFO, not LRU; `asset/magnific_*.png` is unreferenced.
