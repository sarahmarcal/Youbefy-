// Content script injected on Spotify playlist pages
(function () {
  const BTN_ID = "youbefy-convert-btn";
  const SIGNIN_ID = "youbefy-signin-btn";
  const OVERLAY_ID = "youbefy-overlay";

  let isLoggedIn = false;
  let busy = false;
  // Free mode never touches Google sign-in; only "api" mode needs it.
  let mode = "free";

  function createStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${BTN_ID}, #${SIGNIN_ID} {
        position: fixed; right: 24px; z-index: 999999;
        padding: 12px 16px; border-radius: 9999px;
        color: #fff; font-weight: 600; font-size: 14px;
        font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
        border: none; box-shadow: 0 10px 30px rgba(0,0,0,.25); cursor: pointer;
      }
      #${BTN_ID} { bottom: 24px; background: linear-gradient(135deg, #22c55e, #ef4444); }
      #${SIGNIN_ID} { bottom: 76px; background: #1a1a1a; border: 1px solid rgba(255,255,255,.2); }
      #${BTN_ID}:hover, #${SIGNIN_ID}:hover { filter: brightness(1.1); transform: translateY(-1px); }
      #${BTN_ID}[disabled] { opacity: .6; cursor: progress; transform: none; filter: none; }
      #${OVERLAY_ID} {
        position: fixed; inset: 16px; z-index: 999998;
        display: none; align-items: flex-end; justify-content: flex-end; pointer-events: none;
      }
      #${OVERLAY_ID} .panel {
        pointer-events: auto; padding: 12px 16px; border-radius: 12px;
        background: rgba(17,17,17,.92); color: #fff; max-width: 360px;
        box-shadow: 0 8px 24px rgba(0,0,0,.4); font-size: 14px;
        font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      }
      #${OVERLAY_ID} .msg { overflow-wrap: anywhere; }
      #${OVERLAY_ID} .bar {
        height: 6px; background: rgba(255,255,255,.2);
        border-radius: 9999px; overflow: hidden; margin-top: 8px;
      }
      #${OVERLAY_ID} .bar > span {
        display: block; height: 100%; width: 0%;
        background: linear-gradient(90deg, #22c55e, #ef4444);
      }
      @media (prefers-reduced-motion: no-preference) {
        #${BTN_ID}, #${SIGNIN_ID} { transition: transform .2s ease, filter .2s ease; }
        #${OVERLAY_ID} .bar > span { transition: width .2s ease; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "Convert to YouTube";
    btn.addEventListener("click", onConvert);
    document.documentElement.appendChild(btn);
  }

  function ensureSignInButton() {
    if (document.getElementById(SIGNIN_ID)) return;
    const btn = document.createElement("button");
    btn.id = SIGNIN_ID;
    btn.type = "button";
    btn.textContent = "Sign in with Google";
    btn.style.display = "none"; // hidden until we know auth is needed
    btn.addEventListener("click", signIn);
    document.documentElement.appendChild(btn);
  }

  function setSignInVisible(visible) {
    const btn = document.getElementById(SIGNIN_ID);
    if (btn) btn.style.display = visible ? "block" : "none";
  }

  function setBusy(state) {
    busy = state;
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.disabled = state;
  }

  function signIn() {
    showOverlay();
    updateOverlay(0, "Signing in with Google...");
    chrome.runtime.sendMessage({ type: "ENSURE_AUTH" }, (resp) => {
      if (resp?.ok) {
        updateOverlay(100, `Signed in as ${resp.profile?.email || "your Google account"}`);
        isLoggedIn = true;
        setSignInVisible(false);
      } else {
        updateOverlay(0, `Sign-in failed: ${resp?.error || "Unknown error"}`);
      }
      setTimeout(hideOverlay, 2500);
    });
  }

  // A silent pass is expected to fail before the first consent - that is not an
  // error worth surfacing, it just means we show the sign-in button.
  function tryAutoLogin() {
    chrome.runtime.sendMessage({ type: "ENSURE_AUTH", silent: true }, (resp) => {
      void chrome.runtime.lastError; // swallow "no receiving end" on reload
      if (resp?.ok) {
        isLoggedIn = true;
        setSignInVisible(false);
      } else {
        setSignInVisible(mode === "api"); // mode may have flipped meanwhile
      }
    });
  }

  function applyMode(value, delay) {
    mode = value === "api" ? "api" : "free";
    if (mode === "api") setTimeout(tryAutoLogin, delay);
    else setSignInVisible(false);
  }

  function ensureOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    const panel = document.createElement("div");
    panel.className = "panel";
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = "Preparing...";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.appendChild(document.createElement("span"));
    panel.append(msg, bar);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
  }

  function showOverlay() {
    ensureOverlay();
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = "flex";
  }

  function updateOverlay(progress, message) {
    ensureOverlay();
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    const msg = root.querySelector(".msg");
    const bar = root.querySelector(".bar > span");
    if (msg) msg.textContent = message || "";
    if (bar && typeof progress === "number") {
      bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }
  }

  function hideOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = "none";
  }

  function getPlaylistName() {
    const h1 = document.querySelector("h1");
    if (h1?.textContent) return h1.textContent.trim();
    const meta = document.querySelector('meta[property="og:title"]');
    if (meta?.getAttribute("content")) return meta.getAttribute("content");
    return "Spotify Playlist";
  }

  // Read whatever rows are currently mounted in the virtualized tracklist.
  function scrapeVisibleRows() {
    const out = [];
    const rows = document.querySelectorAll('[data-testid="tracklist-row"], [role="row"]');
    rows.forEach((row) => {
      let title = "";
      const titleLink = row.querySelector('a[href^="/track/"]');
      if (titleLink?.textContent) title = titleLink.textContent.trim();
      if (!title) {
        const cell = row.querySelector('[data-testid="internal-track-link"], [aria-colindex="2"]');
        if (cell?.textContent) title = cell.textContent.trim();
      }
      if (!title) return;

      const artistLinks = row.querySelectorAll('a[href^="/artist/"]');
      const artist = Array.from(artistLinks)
        .map((a) => a.textContent?.trim())
        .filter(Boolean)
        .join(", ");

      out.push({ title, artist });
    });
    return out;
  }

  // Spotify's tracklist is virtualized: only ~30 rows exist in the DOM at a time.
  // Find the scroll container so we can walk the whole list.
  function findScroller() {
    const candidates = [
      document.querySelector('[data-overlayscrollbars-viewport]'),
      document.querySelector(".main-view-container__scroll-node"),
      document.querySelector('[data-testid="playlist-page"]')
    ].filter(Boolean);

    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight + 50) return el;
    }

    // Fall back to walking up from a row to the first scrollable ancestor.
    let node = document.querySelector('[data-testid="tracklist-row"]');
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 50) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Scroll through the playlist, collecting rows as they mount.
  async function scrapeAllTracks(onProgress) {
    const seen = new Map(); // key -> {title, artist}, preserves playlist order
    const scroller = findScroller();

    const collect = () => {
      for (const t of scrapeVisibleRows()) {
        const key = `${t.title}__${t.artist}`.toLowerCase();
        if (!seen.has(key)) seen.set(key, t);
      }
    };

    const startTop = scroller.scrollTop;
    collect();

    let stagnant = 0;
    let lastCount = seen.size;

    // Stop when three consecutive passes add nothing new, or when the scroller
    // has stopped moving and the last pass found nothing - that is the bottom.
    while (stagnant < 3) {
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 400);
      await sleep(350);
      collect();

      const grew = seen.size !== lastCount;
      const moved = scroller.scrollTop !== before;
      if (grew) stagnant = 0;
      else if (!moved) stagnant = 3;
      else stagnant++;

      lastCount = seen.size;
      onProgress?.(seen.size);
    }

    scroller.scrollTop = startTop; // put the user back where they were
    return Array.from(seen.values());
  }

  async function onConvert() {
    if (busy) return;
    setBusy(true);
    showOverlay();
    updateOverlay(0, "Loading tracks...");

    try {
      const tracks = await scrapeAllTracks((n) => {
        updateOverlay(0, `Loading tracks... found ${n}`);
      });

      if (!tracks.length) {
        updateOverlay(0, "No tracks found on this page. Is this a playlist page?");
        setTimeout(hideOverlay, 4000);
        setBusy(false);
        return;
      }

      updateOverlay(0, `Found ${tracks.length} tracks. Starting...`);
      chrome.runtime.sendMessage(
        { type: "CONVERT_PLAYLIST", playlistName: getPlaylistName(), tracks },
        () => {
          // Outcome arrives via CONVERSION_PROGRESS / CONVERSION_DONE.
          void chrome.runtime.lastError;
        }
      );
    } catch (err) {
      updateOverlay(0, `Failed to read tracks: ${err?.message || err}`);
      setTimeout(hideOverlay, 4000);
      setBusy(false);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "CONVERSION_PROGRESS") {
      updateOverlay(msg.progress, msg.message);
    }
    if (msg?.type === "CONVERSION_DONE") {
      setBusy(false);
      if (msg.success) {
        // The background opens the tab(s); see openResult() there.
        const opening = msg.playlistId || msg.urls?.length;
        updateOverlay(100, `${msg.summary || "Completed!"}${opening ? " Opening YouTube..." : ""}`);
      } else {
        updateOverlay(0, `Failed: ${msg.error || "Unknown error"}`);
      }
      setTimeout(hideOverlay, 6000);
    }
  });

  // bootstrap
  createStyles();
  ensureOverlay();
  ensureButton();
  ensureSignInButton();
  chrome.storage.sync.get(["mode"], (r) => applyMode(r?.mode, 1000));
  // Switching mode in the options page takes effect without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.mode) applyMode(changes.mode.newValue, 0);
  });
})();
