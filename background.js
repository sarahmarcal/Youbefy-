// Background service worker for Youbefy
// Obtains a Google access token via chrome.identity.launchWebAuthFlow and uses
// the YouTube Data API to create a playlist and fill it with matching videos.
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
// Costs no API quota. Returns null if the page shape changes.
async function scrapeVideoId(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
  const res = await fetch(url, {
    credentials: "omit",
    headers: { "Accept-Language": "en-US,en;q=0.9" }
  });
  if (!res.ok) return null;
  const html = await res.text();

  // videoRenderer entries are the actual results; a bare "videoId" also shows up
  // in unrelated player config, so prefer the renderer match.
  const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/) ||
            html.match(/"videoId":"([\w-]{11})"/);
  return m ? m[1] : null;
}

// Paid fallback: 100 quota units per call.
async function searchVideoIdViaApi(query, token) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}`;
  const data = await ytFetch(url, "GET", token);
  return data.items?.[0]?.id?.videoId || null;
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

// ------------------------------------------------------------ messaging

function sendProgress(tabId, progress, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "CONVERSION_PROGRESS", progress, message }).catch(() => {});
}

async function convertPlaylist(message, tabId) {
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

  for (let i = 0; i < limited.length; i++) {
    const t = limited[i];
    const query = `${t.title} ${t.artist}`.trim();
    const key = query.toLowerCase();
    sendProgress(
      tabId,
      Math.round((i / limited.length) * 100),
      `(${i + 1}/${limited.length}) ${query}`
    );

    let videoId = cache[key];
    if (videoId === undefined) {
      try {
        videoId = await scrapeVideoId(query);
      } catch {
        videoId = null;
      }
      if (!videoId) {
        // Only spend quota when the free path came up empty.
        try {
          videoId = await searchVideoIdViaApi(query, token);
        } catch (err) {
          if (err.quotaExceeded) throw err;
          videoId = null;
        }
      }
      cache[key] = videoId || null;
    }

    if (videoId) {
      await addVideoToPlaylist(playlistId, videoId, token);
      added++;
    } else {
      missed++;
    }
  }

  await saveCache(cache);

  const summary = missed
    ? `Done - added ${added}, could not match ${missed}.`
    : `Done - added ${added} tracks.`;
  sendProgress(tabId, 100, summary);
  return { playlistId, added, missed, summary };
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
      try {
        const result = await convertPlaylist(message, tabId);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "CONVERSION_DONE",
            success: true,
            ...result
          }).catch(() => {});
        }
        sendResponse({ ok: true, ...result });
      } catch (err) {
        const msg = err?.message || String(err);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "CONVERSION_DONE",
            success: false,
            error: msg
          }).catch(() => {});
        }
        sendResponse({ ok: false, error: msg });
      }
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
  })();
  return true; // keep the channel open for the async sendResponse
});
