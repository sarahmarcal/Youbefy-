// Background service worker for Youbefy
// Two modes, picked in the options page (storage key `mode`):
// - "free" (default): resolve videos by scraping and hand them to YouTube's
//   watch_videos endpoint, which builds an anonymous temporary playlist. No
//   Google account, no OAuth client, no API quota.
// - "api": obtain a Google access token via chrome.identity.launchWebAuthFlow
//   and use the YouTube Data API to create a real playlist on the account.
//
// Quota note: search.list costs 100 units/call against a 10,000 unit/day default
// quota, which caps you at ~100 lookups per day. To avoid that we resolve videos
// by scraping youtube.com/results (0 quota) and only fall back to the official
// search endpoint when scraping fails. See README.md.

// One combined scope set so the user consents once, not twice.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "openid",
  "email",
  "profile"
];

const MAX_TRACKS = 200;
const CACHE_KEY = "videoIdCache";
const CACHE_LIMIT = 2000;
// A track we genuinely could not match is remembered so repeat runs do not pay
// for the lookup again, but only for a while - YouTube's catalogue changes.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Free mode only: pause between network scrapes (not cache hits) so a long
// playlist does not hammer youtube.com/results and get throttled.
// 300 ms got the extension sent to Google's CAPTCHA within one 50-track run.
const SCRAPE_DELAY_MS = 1000;
const SCRAPE_RETRY_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}

function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setLocal(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function parseFragment(fragment) {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- auth

async function launchAuth(interactive) {
  const { googleClientId } = await getStorage(["googleClientId"]);
  if (!googleClientId) {
    throw new Error("Missing Google OAuth Client ID. Set it in the extension options.");
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId);
  authUrl.searchParams.set("redirect_uri", chrome.identity.getRedirectURL("oauth2"));
  authUrl.searchParams.set("response_type", "token"); // implicit grant for simplicity
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("include_granted_scopes", "true");
  // Only force the consent screen when the user is actively signing in; a silent
  // pass must never prompt.
  authUrl.searchParams.set("prompt", interactive ? "consent" : "none");

  const redirect = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive },
      (redirectUrl) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!redirectUrl) return reject(new Error("No redirect URL"));
        resolve(redirectUrl);
      }
    );
  });

  const result = parseFragment(`#${redirect.split("#")[1] || ""}`);
  if (!result.access_token) {
    throw new Error(result.error || "Failed to obtain access token");
  }

  const expiresIn = Number(result.expires_in || 3600);
  const tokenInfo = {
    accessToken: result.access_token,
    expiry: Date.now() + (expiresIn - 60) * 1000 // renew 1 min early
  };
  await setStorage({ googleToken: tokenInfo });
  return tokenInfo.accessToken;
}

async function fetchUserInfo(token) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`userinfo error ${res.status}`);
  return res.json();
}

// Returns { token, profile }. A single consent covers both sign-in and YouTube.
async function ensureAuth(interactive = true) {
  const { googleToken, googleProfile } = await getStorage(["googleToken", "googleProfile"]);

  if (googleToken?.accessToken && googleToken.expiry && Date.now() < googleToken.expiry) {
    if (googleProfile) return { token: googleToken.accessToken, profile: googleProfile };
    const profile = await fetchUserInfo(googleToken.accessToken);
    await setStorage({ googleProfile: profile });
    return { token: googleToken.accessToken, profile };
  }

  const token = await launchAuth(interactive);
  const profile = await fetchUserInfo(token);
  await setStorage({ googleProfile: profile });
  return { token, profile };
}

// --------------------------------------------------------- youtube api

async function ytFetch(endpoint, method = "GET", token, body) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://www.googleapis.com/youtube/v3/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403 && /quota/i.test(text)) {
      const err = new Error("YouTube API daily quota exceeded. Try again after it resets (midnight Pacific time).");
      err.quotaExceeded = true;
      throw err;
    }
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function createPlaylist(name, description, privacyStatus, token) {
  const data = await ytFetch("playlists?part=snippet,status", "POST", token, {
    snippet: { title: name, description: description || "Created with Youbefy" },
    status: { privacyStatus }
  });
  return data.id;
}

async function addVideoToPlaylist(playlistId, videoId, token) {
  await ytFetch("playlistItems?part=snippet", "POST", token, {
    snippet: {
      playlistId,
      resourceId: { kind: "youtube#video", videoId }
    }
  });
}

// ------------------------------------------------------ video resolution

// Free path: parse a video id out of the youtube.com search results page.
// Costs no API quota. Returns null only for a real results page with no video
// on it; anything else throws, so callers do not cache a throttle or a consent
// page as a confirmed no-match. YouTube does throttle bursts: it redirects
// flagged traffic to google.com/sorry (a CAPTCHA), which fetch() would only
// report as a CORS failure. Not following redirects keeps that recognisable;
// such errors carry `blocked: true` so callers stop searching instead of
// prolonging the block.
async function scrapeVideoId(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
  const res = await fetch(url, {
    credentials: "omit",
    redirect: "manual",
    headers: { "Accept-Language": "en-US,en;q=0.9" }
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    const err = new Error("youtube redirected the search (bot check / CAPTCHA)");
    err.blocked = true;
    throw err;
  }
  if (!res.ok) throw new Error(`youtube results ${res.status}`);
  const html = await res.text();
  if (!html.includes("ytInitialData")) throw new Error("not a youtube results page");

  // Only videoRenderer entries are results. A bare "videoId" also appears in
  // unrelated player config, so matching it would pick an arbitrary video.
  const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/);
  return m ? m[1] : null;
}

// Paid fallback: 100 quota units per call.
async function searchVideoIdViaApi(query, token) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}`;
  const data = await ytFetch(url, "GET", token);
  return data.items?.[0]?.id?.videoId || null;
}

// Cache entries are either a video id string (a hit, kept indefinitely) or
// { miss: timestamp } (a confirmed no-match, re-checked once the TTL lapses).
// Anything else - including the bare nulls written by 0.2.0 - is treated as
// absent, so a track is never permanently poisoned by one bad lookup.
function cachedVideoId(cache, key) {
  const entry = cache[key];
  if (typeof entry === "string" && entry) return entry;
  if (entry && typeof entry === "object" && Date.now() - entry.miss < MISS_TTL_MS) {
    return null; // known miss, still fresh: skip the lookup
  }
  return undefined; // no usable entry - look it up
}

async function loadCache() {
  const stored = await getLocal([CACHE_KEY]);
  return stored[CACHE_KEY] || {};
}

async function saveCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    // Drop the oldest half; insertion order is a good enough LRU stand-in.
    const trimmed = {};
    for (const k of keys.slice(keys.length - Math.floor(CACHE_LIMIT / 2))) trimmed[k] = cache[k];
    cache = trimmed;
  }
  await setLocal({ [CACHE_KEY]: cache });
}

// ------------------------------------------------------------ free mode

// Returns an array of watch_videos URLs, one per chunk of at most `chunkSize` ids.
// Drops falsy ids and duplicates (first occurrence wins, order preserved).
//
// 50 is YouTube's real per-URL limit, measured 2026-10-29 with 119 distinct ids:
// 49 and 50 ids redirect to different TLGG lists, but 50, 51, 75, 100 and 119
// all redirect to the *same* list, whose watch page reports totalVideos: 50 and
// contains none of ids 51+. Extra ids are dropped silently, not rejected.
function buildWatchVideosUrls(videoIds, chunkSize = 50) {
  const size = chunkSize >= 1 ? Math.floor(chunkSize) : 50; // never loop on 0/NaN
  const unique = [...new Set((videoIds || []).filter(Boolean))];
  const urls = [];
  for (let i = 0; i < unique.length; i += size) {
    urls.push(`https://www.youtube.com/watch_videos?video_ids=${unique.slice(i, i + size).join(",")}`);
  }
  return urls;
}

// ------------------------------------------------------------ messaging

function sendProgress(tabId, progress, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "CONVERSION_PROGRESS", progress, message }).catch(() => {});
}

// Unset counts as free: a fresh install should work with zero setup.
async function convertPlaylist(message, tabId) {
  const { mode } = await getStorage(["mode"]);
  return mode === "api"
    ? convertPlaylistViaApi(message, tabId)
    : convertPlaylistFree(message, tabId);
}

// No token here, so no API fallback: a track the scrape cannot find is a miss.
async function convertPlaylistFree(message, tabId) {
  const limited = (message.tracks || []).slice(0, MAX_TRACKS);
  if (!limited.length) throw new Error("No tracks were provided.");

  const cache = await loadCache();
  const videoIds = [];
  let missed = 0;
  let scraped = false;
  let blocked = false;

  try {
    for (let i = 0; i < limited.length && !blocked; i++) {
      const t = limited[i];
      const query = `${t.title} ${t.artist}`.trim();
      const key = query.toLowerCase();
      sendProgress(
        tabId,
        Math.round((i / limited.length) * 100),
        `(${i + 1}/${limited.length}) ${query}`
      );

      let videoId = cachedVideoId(cache, key);
      if (videoId === undefined) {
        if (scraped) await sleep(SCRAPE_DELAY_MS);
        scraped = true;
        // Same rule as API mode: a thrown lookup is not a confirmed miss.
        // A failure is usually YouTube throttling the burst, so back off and
        // retry once before giving up on the track.
        let failed = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await sleep(SCRAPE_RETRY_MS);
          try {
            videoId = await scrapeVideoId(query);
            failed = false;
            break;
          } catch (err) {
            console.warn("[youbefy] lookup failed:", query, err?.message || err);
            videoId = null;
            failed = true;
            // Retrying or moving on to the next track only extends the block.
            if (err?.blocked) {
              blocked = true;
              break;
            }
          }
        }
        if (videoId) cache[key] = videoId;
        else if (!failed) cache[key] = { miss: Date.now() };
      }

      if (videoId) videoIds.push(videoId);
      else if (!blocked) missed++;
    }
  } finally {
    await saveCache(cache);
  }

  const BLOCKED_HINT = "YouTube asked for a bot check (CAPTCHA). Matches so far are cached - " +
    "wait a while and run again, or switch to API mode in the extension options.";
  if (blocked && !videoIds.length) throw new Error(BLOCKED_HINT);

  const urls = buildWatchVideosUrls(videoIds);
  // Two tracks can resolve to the same video; watch_videos lists it once, so
  // count what actually lands in the playlist.
  const added = new Set(videoIds).size;
  const parts = urls.length > 1 ? `, split into ${urls.length} parts (YouTube allows 50 per list)` : "";
  const misses = missed ? ` Could not match ${missed}.` : "";
  const summary = blocked
    ? `Stopped early - ${added} videos in a temporary YouTube playlist${parts}. ${BLOCKED_HINT}`
    : added
      ? `Done - ${added} videos in a temporary YouTube playlist${parts}.${misses}`
      : `Done - could not match any of ${limited.length} tracks.`;
  sendProgress(tabId, 100, summary);
  return { urls, added, missed, summary };
}

async function convertPlaylistViaApi(message, tabId) {
  const { playlistName, tracks } = message;
  const limited = (tracks || []).slice(0, MAX_TRACKS);
  if (!limited.length) throw new Error("No tracks were provided.");

  const { privacy } = await getStorage(["privacy"]);

  sendProgress(tabId, 0, "Signing in to Google...");
  const { token } = await ensureAuth(true);

  sendProgress(tabId, 0, "Creating YouTube playlist...");
  const playlistId = await createPlaylist(
    playlistName || "Spotify Playlist",
    `Imported from Spotify: ${playlistName || "Untitled"}`,
    privacy || "private",
    token
  );

  const cache = await loadCache();
  let added = 0;
  let missed = 0;
  // Once YouTube shows the bot check, stop scraping and use the API directly.
  let scrapeBlocked = false;

  // Everything resolved so far is worth keeping even if the run dies partway -
  // a quota failure is exactly when the next attempt most needs the cache.
  try {
    for (let i = 0; i < limited.length; i++) {
      const t = limited[i];
      const query = `${t.title} ${t.artist}`.trim();
      const key = query.toLowerCase();
      sendProgress(
        tabId,
        Math.round((i / limited.length) * 100),
        `(${i + 1}/${limited.length}) ${query}`
      );

      let videoId = cachedVideoId(cache, key);
      if (videoId === undefined) {
        // A lookup that threw is a transient failure, not a confirmed no-match,
        // so it must not be recorded as a miss.
        let failed = false;
        videoId = null;
        if (!scrapeBlocked) {
          try {
            videoId = await scrapeVideoId(query);
          } catch (err) {
            if (err?.blocked) scrapeBlocked = true;
            failed = true;
          }
        }
        if (!videoId) {
          // Only spend quota when the free path came up empty.
          try {
            videoId = await searchVideoIdViaApi(query, token);
            failed = false;
          } catch (err) {
            if (err.quotaExceeded) throw err;
            videoId = null;
            failed = true;
          }
        }
        if (videoId) cache[key] = videoId;
        else if (!failed) cache[key] = { miss: Date.now() };
      }

      if (videoId) {
        await addVideoToPlaylist(playlistId, videoId, token);
        added++;
      } else {
        missed++;
      }
    }
  } finally {
    await saveCache(cache);
  }

  const summary = missed
    ? `Done - added ${added}, could not match ${missed}.`
    : `Done - added ${added} tracks.`;
  sendProgress(tabId, 100, summary);
  return { playlistId, added, missed, summary };
}

// Opened from here rather than via window.open in the content script: by the
// time a conversion finishes there is no user gesture left, so the page's
// popup blocker would eat it. Only the first tab takes focus.
function openResult(result) {
  const urls = result.urls ||
    (result.playlistId ? [`https://www.youtube.com/playlist?list=${result.playlistId}`] : []);
  urls.forEach((url, i) => {
    chrome.tabs.create({ url, active: i === 0 }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tabId = sender?.tab?.id;

    if (message?.type === "ENSURE_AUTH") {
      try {
        const { profile } = await ensureAuth(!message.silent);
        sendResponse({ ok: true, profile });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (message?.type === "CONVERT_PLAYLIST") {
      // A conversion runs for minutes; the message port will not survive that.
      // Acknowledge receipt now and report the outcome over tabs.sendMessage.
      sendResponse({ ok: true, started: true });
      try {
        const result = await convertPlaylist(message, tabId);
        openResult(result);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "CONVERSION_DONE",
            success: true,
            ...result
          }).catch(() => {});
        }
      } catch (err) {
        const msg = err?.message || String(err);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "CONVERSION_DONE",
            success: false,
            error: msg
          }).catch(() => {});
        }
      }
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
  })();
  return true; // keep the channel open for the async sendResponse
});
