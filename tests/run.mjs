#!/usr/bin/env node
// Youbefy validation harness - zero dependencies, Node >= 18 (built-in fetch).
//
//   node tests/run.mjs            offline + live tests
//   node tests/run.mjs --offline  offline tests only (no network)
//
// background.js is a classic script, so it is evaluated inside a node:vm
// context with a minimal `chrome` stub; its top-level functions become globals
// of that context. Nothing here needs Google Cloud, OAuth, or Chrome.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BG_PATH = path.join(HERE, "..", "background.js");
const BG_SRC = fs.readFileSync(BG_PATH, "utf8");
const OFFLINE = process.argv.includes("--offline");
const LIVE_GAP_MS = 300;
const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ runner

class Skip extends Error {}
const skip = (msg) => { throw new Skip(msg); };
const results = { offline: { pass: 0, fail: 0, skip: 0 }, live: { pass: 0, fail: 0, skip: 0 } };
const failures = [];

async function test(group, name, fn) {
  const r = results[group];
  try {
    await fn();
    r.pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    if (err instanceof Skip) {
      r.skip++;
      console.log(`  SKIP  ${name}\n        -> ${err.message}`);
    } else {
      r.fail++;
      failures.push(`[${group}] ${name}`);
      console.log(`  FAIL  ${name}\n        -> ${oneLine(err)}`);
    }
  }
}

function oneLine(err) {
  if (!err) return String(err);
  if (err.code === "ERR_ASSERTION" && err.generatedMessage === false) return err.message;
  const cause = err.cause?.code || err.cause?.message;
  return `${err.message}${cause ? ` (${cause})` : ""}`.split("\n").slice(0, 6).join("\n           ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Values created inside the vm realm have foreign prototypes; strict deep
// equality would reject them, so compare plain JSON copies.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ------------------------------------------------------- background loader

function makeStorageArea(initial = {}) {
  const data = { ...initial };
  const pick = (keys) => {
    if (keys == null) return structuredClone(data);
    if (typeof keys === "string") keys = [keys];
    const out = {};
    if (Array.isArray(keys)) {
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
    } else {
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? structuredClone(data[k]) : def;
    }
    return out;
  };
  // Callback style like the real API, but also promise-returning when no
  // callback is passed (MV3 supports both), so either style of caller works.
  return {
    data,
    get(keys, cb) {
      const out = pick(keys);
      if (typeof cb === "function") { setTimeout(() => cb(out), 0); return; }
      return Promise.resolve(out);
    },
    set(obj, cb) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
      if (typeof cb === "function") { setTimeout(() => cb(), 0); return; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of [].concat(keys)) delete data[k];
      if (typeof cb === "function") { setTimeout(() => cb(), 0); return; }
      return Promise.resolve();
    }
  };
}

/**
 * Evaluate background.js in a fresh context.
 * opts.fetch: fetch implementation (default: real fetch). Every URL is recorded.
 */
function loadBackground({ sync = {}, local = {}, fetch: fetchImpl = globalThis.fetch } = {}) {
  const calls = { fetch: [], tabsCreate: [], tabsSendMessage: [], listeners: [] };
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => calls.listeners.push(fn) },
      getURL: (p) => `chrome-extension://test/${p}`
    },
    storage: { sync: makeStorageArea(sync), local: makeStorageArea(local) },
    identity: {
      getRedirectURL: (p = "") => `https://khkddicldodofidklleknlgokhkchbei.chromiumapp.org/${p}`,
      // No browser here: the OAuth flow always fails like a cancelled popup.
      launchWebAuthFlow: (_opts, cb) => {
        chrome.runtime.lastError = { message: "launchWebAuthFlow unavailable in test harness" };
        setTimeout(() => { cb(undefined); chrome.runtime.lastError = undefined; }, 0);
      }
    },
    tabs: {
      sendMessage: (...args) => { calls.tabsSendMessage.push(args); return Promise.resolve(); },
      create: (props, cb) => {
        calls.tabsCreate.push(props);
        const tab = { id: 999, ...props };
        if (typeof cb === "function") setTimeout(() => cb(tab), 0);
        return Promise.resolve(tab);
      }
    }
  };
  const recordingFetch = (input, init) => {
    calls.fetch.push(typeof input === "string" ? input : input?.url ?? String(input));
    return fetchImpl(input, init);
  };
  const sandbox = {
    chrome,
    fetch: recordingFetch,
    URL, URLSearchParams, Headers, Response, Request, AbortController,
    TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(BG_SRC, ctx, { filename: "background.js" });
  // `const` bindings are not context properties; expose them via evaluation.
  const constant = (name) => vm.runInContext(`typeof ${name} === "undefined" ? undefined : ${name}`, ctx);
  return { ctx, chrome, calls, constant };
}

function fnOrSkip(ctx, name, why) {
  if (typeof ctx[name] !== "function") skip(`${name}() not found in background.js${why ? ` - ${why}` : ""}`);
  return ctx[name];
}

// -------------------------------------------------------------- offline

async function offlineTests() {
  console.log("\nOffline tests");

  // 1. cachedVideoId
  await test("offline", "cachedVideoId: hit / fresh miss / stale miss / legacy null / absent", () => {
    const { ctx } = loadBackground();
    const now = Date.now();
    const cache = {
      hit: "dQw4w9WgXcQ",
      freshMiss: { miss: now },
      staleMiss: { miss: now - 8 * DAY },
      legacyNull: null,
      emptyString: ""
    };
    assert.equal(ctx.cachedVideoId(cache, "hit"), "dQw4w9WgXcQ", "string hit should be returned");
    assert.equal(ctx.cachedVideoId(cache, "freshMiss"), null, "fresh {miss} should be null (skip lookup)");
    assert.equal(ctx.cachedVideoId(cache, "staleMiss"), undefined, "{miss} older than 7 days should be undefined");
    assert.equal(ctx.cachedVideoId(cache, "legacyNull"), undefined, "0.2.0 bare null should be undefined");
    assert.equal(ctx.cachedVideoId(cache, "emptyString"), undefined, "empty string should be undefined");
    assert.equal(ctx.cachedVideoId(cache, "nope"), undefined, "missing key should be undefined");
  });

  // 2. saveCache trimming
  await test("offline", "saveCache: >2000 entries keeps newest 1000 in insertion order", async () => {
    const { ctx, chrome, constant } = loadBackground();
    const key = constant("CACHE_KEY") ?? "videoIdCache";
    const cache = {};
    for (let i = 0; i < 2500; i++) cache[`track ${i}`] = `id${String(i).padStart(9, "0")}`;
    await ctx.saveCache(cache);
    const stored = chrome.storage.local.data[key];
    assert.ok(stored, `nothing stored under "${key}"`);
    const keys = Object.keys(stored);
    assert.equal(keys.length, 1000, `expected 1000 entries, got ${keys.length}`);
    assert.equal(keys[0], "track 1500");
    assert.equal(keys[999], "track 2499");
    assert.equal(stored["track 2499"], cache["track 2499"]);
  });

  await test("offline", "saveCache: <=2000 entries keeps everything", async () => {
    const { ctx, chrome, constant } = loadBackground();
    const key = constant("CACHE_KEY") ?? "videoIdCache";
    for (const n of [0, 5, 2000]) {
      const cache = {};
      for (let i = 0; i < n; i++) cache[`t ${i}`] = i % 3 ? `v${i}` : { miss: 1 };
      await ctx.saveCache(cache);
      assert.equal(Object.keys(chrome.storage.local.data[key]).length, n, `n=${n}`);
      assert.deepEqual(plain(chrome.storage.local.data[key]), plain(cache));
    }
  });

  // 3. parseFragment
  await test("offline", "parseFragment: #access_token=a&expires_in=3600", () => {
    const { ctx } = loadBackground();
    assert.deepEqual(plain(ctx.parseFragment("#access_token=a&expires_in=3600")),
      { access_token: "a", expires_in: "3600" });
    assert.deepEqual(plain(ctx.parseFragment("access_token=a%2Bb&token_type=Bearer")),
      { access_token: "a+b", token_type: "Bearer" }, "works without leading # and decodes");
    assert.deepEqual(plain(ctx.parseFragment("#")), {});
  });

  // 4. buildWatchVideosUrls
  const WHY_BUILD = "free mode not added yet (expected while the other change is in progress)";
  const idsOf = (u) => {
    const url = new URL(u);
    assert.equal(url.origin + url.pathname, "https://www.youtube.com/watch_videos", `bad URL: ${u}`);
    return (url.searchParams.get("video_ids") || "").split(",").filter(Boolean);
  };
  const fakeIds = (n) => Array.from({ length: n }, (_, i) => `vid${String(i).padStart(8, "0")}`);

  await test("offline", "buildWatchVideosUrls: empty input -> []", () => {
    const { ctx } = loadBackground();
    const build = fnOrSkip(ctx, "buildWatchVideosUrls", WHY_BUILD);
    assert.deepEqual(plain(build([])), []);
    assert.deepEqual(plain(build([null, "", undefined])), [], "all-falsy input -> []");
  });

  await test("offline", "buildWatchVideosUrls: drops falsy + duplicates, first occurrence wins, order kept", () => {
    const { ctx } = loadBackground();
    const build = fnOrSkip(ctx, "buildWatchVideosUrls", WHY_BUILD);
    const urls = plain(build(["ccccccccccc", null, "aaaaaaaaaaa", "", "ccccccccccc", undefined, "bbbbbbbbbbb", "aaaaaaaaaaa"]));
    assert.equal(urls.length, 1);
    assert.deepEqual(idsOf(urls[0]), ["ccccccccccc", "aaaaaaaaaaa", "bbbbbbbbbbb"]);
  });

  await test("offline", "buildWatchVideosUrls: 120 ids chunked (explicit 50 and default), order preserved", () => {
    const { ctx } = loadBackground();
    const build = fnOrSkip(ctx, "buildWatchVideosUrls", WHY_BUILD);
    const ids = fakeIds(120);

    const explicit = plain(build(ids, 50));
    assert.equal(explicit.length, 3, `chunkSize=50: expected 3 URLs, got ${explicit.length}`);
    assert.deepEqual(explicit.map((u) => idsOf(u).length), [50, 50, 20]);
    assert.deepEqual(explicit.flatMap(idsOf), ids, "ids must come out in input order");

    const small = plain(build(ids, 7));
    assert.equal(small.length, Math.ceil(120 / 7));
    assert.ok(small.every((u) => idsOf(u).length <= 7));
    assert.deepEqual(small.flatMap(idsOf), ids);

    // Default: read it from the signature when possible instead of assuming 50.
    const m = String(build).match(/chunkSize\s*=\s*(\d+)/);
    const def = m ? Number(m[1]) : 50;
    const dflt = plain(build(ids));
    assert.equal(dflt.length, Math.ceil(120 / def), `default chunkSize=${def}: expected ${Math.ceil(120 / def)} URLs, got ${dflt.length}`);
    assert.deepEqual(dflt.flatMap(idsOf), ids);
    if (def !== 50) console.log(`        note: default chunkSize is ${def}, not 50`);
  });

  // 5. convertPlaylist in free mode
  await test("offline", "convertPlaylist (free mode): no Google API/OAuth calls, watch_videos tab opened", async () => {
    const freeInSource = /["']free["']/.test(BG_SRC);
    const cannedId = (q) => {
      // Deterministic 11-char id per query.
      let h = 0;
      for (const c of q) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return ("Q" + h.toString(36) + "xxxxxxxxxxx").slice(0, 11).replace(/[^\w-]/g, "x");
    };
    const expected = [];
    const fakeFetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.youtube.com" && url.pathname === "/results") {
        const id = cannedId(url.searchParams.get("search_query") || "");
        const html = `<html><script>var ytInitialData = {"contents":{"twoColumnSearchResultsRenderer":{"primaryContents":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[{"videoRenderer":{"videoId":"${id}","title":{"runs":[{"text":"x"}]}}}]}}]}}}}};</script></html>`;
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      // Anything else (googleapis, accounts.google.com, ...) is not allowed in free mode.
      return new Response(JSON.stringify({ error: "blocked by harness" }), { status: 401 });
    };
    const { ctx, calls } = loadBackground({ sync: { mode: "free" }, fetch: fakeFetch });
    if (typeof ctx.convertPlaylist !== "function") skip("convertPlaylist() not found");

    const tracks = [
      { title: "Garota de Ipanema", artist: "Tom Jobim" },
      { title: "Evidências", artist: "Chitãozinho & Xororó" },
      { title: "Aquarela", artist: "Toquinho" }
    ];
    for (const t of tracks) expected.push(cannedId(`${t.title} ${t.artist}`.trim()));

    let result;
    try {
      result = await ctx.convertPlaylist({ playlistName: "Harness", tracks }, 1);
    } catch (err) {
      const msg = oneLine(err);
      if (!freeInSource && typeof ctx.buildWatchVideosUrls !== "function") {
        skip(`free mode not implemented yet (convertPlaylist threw: ${msg})`);
      }
      throw new Error(`convertPlaylist threw in free mode: ${msg}. Fetched: ${calls.fetch.join(", ") || "(none)"}`);
    }

    const checkFetches = (c, label) => {
      const forbidden = c.fetch.filter((u) => /googleapis\.com|accounts\.google\.com/.test(u));
      assert.deepEqual(forbidden, [], `${label}: free mode must not hit Google APIs/OAuth, but fetched: ${forbidden.join(", ")}`);
      const scrapes = c.fetch.filter((u) => u.startsWith("https://www.youtube.com/results"));
      assert.equal(scrapes.length, 3, `${label}: expected 3 results-page scrapes, got ${scrapes.length}`);
    };
    const watchIds = (urls) => urls.flatMap((u) => (new URL(u).searchParams.get("video_ids") || "").split(","));
    checkFetches(calls, "convertPlaylist()");
    console.log(`        result: ${JSON.stringify(plain(result))}`);
    if (Array.isArray(result?.urls)) {
      assert.deepEqual(watchIds(plain(result.urls)), expected, "result.urls should carry the scraped ids in track order");
    }

    // The tab may be opened by convertPlaylist itself or by the CONVERT_PLAYLIST
    // message handler (the real entry point). Accept either; drive the handler
    // in a fresh context if the direct call did not open anything.
    let created = calls.tabsCreate.map((p) => p?.url).filter(Boolean);
    let via = "convertPlaylist()";
    if (!created.some((u) => u.includes("watch_videos"))) {
      const bg2 = loadBackground({ sync: { mode: "free" }, fetch: fakeFetch });
      const listener = bg2.calls.listeners[0];
      assert.ok(listener, "no runtime.onMessage listener registered");
      const acks = [];
      const keepOpen = listener({ type: "CONVERT_PLAYLIST", playlistName: "Harness", tracks }, { tab: { id: 1 } }, (r) => acks.push(r));
      assert.equal(keepOpen, true, "listener should return true to keep the channel open");
      const deadline = Date.now() + 15000;
      const isDone = () => bg2.calls.tabsSendMessage.find(([, m]) => m?.type === "CONVERSION_DONE");
      while (!isDone() && Date.now() < deadline) await sleep(50);
      const done = isDone();
      assert.ok(done, "no CONVERSION_DONE message within 15s");
      assert.equal(done[1].success, true, `CONVERSION_DONE reported failure: ${done[1].error}`);
      checkFetches(bg2.calls, "CONVERT_PLAYLIST message");
      created = bg2.calls.tabsCreate.map((p) => p?.url).filter(Boolean);
      via = "CONVERT_PLAYLIST message handler";
    }
    const watch = created.filter((u) => u.includes("watch_videos"));
    assert.ok(watch.length >= 1, `tabs.create was not called with a watch_videos URL (create calls: ${JSON.stringify(created)})`);
    assert.deepEqual(watchIds(watch), expected, "watch_videos URL should carry the scraped ids in track order");
    console.log(`        watch_videos tab opened by the ${via}`);
  });
}

// ----------------------------------------------------------------- live

const LIVE_TRACKS = [
  { title: "Garota de Ipanema", artist: "Tom Jobim" },
  { title: "Evidências", artist: "Chitãozinho & Xororó" },
  { title: "Aquarela", artist: "Toquinho" },
  { title: "Águas de Março", artist: "Elis Regina" },
  { title: "Mas Que Nada", artist: "Jorge Ben Jor" },
  { title: "Ai Se Eu Te Pego", artist: "Michel Teló" },
  { title: "Bohemian Rhapsody", artist: "Queen" },
  { title: "Billie Jean", artist: "Michael Jackson" },
  { title: "Despacito", artist: "Luis Fonsi" },
  { title: "Dynamite", artist: "BTS" },
  { title: "La Vie en Rose", artist: "Édith Piaf" },
  // Trap: the 1994 live version is often the most-viewed upload.
  { title: "Hotel California", artist: "Eagles", trap: true }
];

const VERSION_WORDS = /\b(live|ao vivo|en vivo|remix|cover|karaoke|acoustic|acustico|instrumental|sped up|slowed|nightcore|8d)\b/;

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !["the", "and"].includes(t));

function describeNetErr(err) {
  const code = err?.cause?.code || err?.code;
  const hint = {
    ENOTFOUND: "DNS lookup failed - are you offline?",
    EAI_AGAIN: "DNS temporarily unavailable - are you offline?",
    ECONNREFUSED: "connection refused",
    ECONNRESET: "connection reset",
    ETIMEDOUT: "timed out",
    UND_ERR_CONNECT_TIMEOUT: "connect timed out"
  }[code];
  return `${err?.message || err}${code ? ` [${code}]` : ""}${hint ? ` - ${hint}` : ""}`;
}

async function liveTests() {
  console.log("\nLive tests (real youtube.com, no auth)");

  // Preflight so a dead network gives one clear line instead of 13 failures.
  try {
    const r = await fetch("https://www.youtube.com/", { method: "HEAD", signal: AbortSignal.timeout(10000) });
    if (r.status >= 500) throw new Error(`youtube.com answered HTTP ${r.status}`);
  } catch (err) {
    await test("live", "network preflight (youtube.com reachable)", () => {
      throw new Error(`cannot reach youtube.com: ${describeNetErr(err)}. Use --offline to run only the offline tests.`);
    });
    return;
  }

  const { ctx } = loadBackground();
  const rows = [];

  await test("live", `scrapeVideoId resolves >=75% of ${LIVE_TRACKS.length} real tracks`, async () => {
    for (const t of LIVE_TRACKS) {
      const query = `${t.title} ${t.artist}`.trim();
      const row = { query, id: null, title: "", channel: "", flags: [] };
      rows.push(row);
      try {
        row.id = await ctx.scrapeVideoId(query);
      } catch (err) {
        row.flags.push(`scrape error: ${describeNetErr(err)}`);
      }
      await sleep(LIVE_GAP_MS);
      if (!row.id) continue;
      try {
        const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${row.id}`)}&format=json`);
        if (o.ok) {
          const j = await o.json();
          row.title = j.title || "";
          row.channel = j.author_name || "";
        } else {
          row.flags.push(`oembed HTTP ${o.status}`);
        }
      } catch (err) {
        row.flags.push(`oembed error: ${describeNetErr(err)}`);
      }
      await sleep(LIVE_GAP_MS);
      if (row.title || row.channel) {
        const hay = norm(`${row.title} ${row.channel}`);
        if (!tokens(t.artist).some((tok) => hay.includes(tok))) row.flags.push("artist not in title/channel");
        const ver = norm(row.title).match(VERSION_WORDS);
        if (ver && !VERSION_WORDS.test(norm(query))) row.flags.push(`version: "${ver[1]}"${t.trap ? " (trap sprung)" : ""}`);
      }
    }

    printTable(rows);
    const resolved = rows.filter((r) => r.id).length;
    const ratio = resolved / rows.length;
    console.log(`        resolved ${resolved}/${rows.length} (${Math.round(ratio * 100)}%), flagged ${rows.filter((r) => r.flags.length).length}`);
    assert.ok(ratio >= 0.75,
      `only ${resolved}/${rows.length} queries returned an id - the results-page scraper is probably broken (YouTube HTML changed?)`);
  });

  await test("live", "watch_videos URL redirects (3xx) to a temporary TLGG playlist", async () => {
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (!ids.length) skip("no ids resolved by the previous test");
    let urls;
    if (typeof ctx.buildWatchVideosUrls === "function") {
      urls = plain(ctx.buildWatchVideosUrls(ids));
      console.log("        (URL built with background.js buildWatchVideosUrls)");
    } else {
      urls = [`https://www.youtube.com/watch_videos?video_ids=${[...new Set(ids)].join(",")}`];
      console.log("        (buildWatchVideosUrls absent - URL built by the harness)");
    }
    assert.ok(urls.length >= 1, "no URL produced");
    for (const u of urls) {
      let res;
      try {
        res = await fetch(u, { redirect: "manual" });
      } catch (err) {
        throw new Error(`request failed: ${describeNetErr(err)}`);
      }
      const loc = res.headers.get("location") || "";
      console.log(`        ${u}\n          -> HTTP ${res.status} ${loc}`);
      assert.ok(res.status >= 300 && res.status < 400, `expected 3xx, got ${res.status}`);
      assert.ok(loc.includes("list=TLGG"), `location has no list=TLGG: ${loc}`);
      await sleep(LIVE_GAP_MS);
    }
    console.log(`        Open in a browser to check by ear:\n        ${urls.join("\n        ")}`);
  });
}

function printTable(rows) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const qw = Math.max(...rows.map((r) => r.query.length), 5);
  console.log("");
  for (const r of rows) {
    const mark = !r.id ? "MISS" : r.flags.length ? "FLAG" : " ok ";
    const body = r.id ? `${r.id}  ${clip(r.title, 60)} — ${clip(r.channel, 30)}` : "(no id)";
    console.log(`   [${mark}] ${r.query.padEnd(qw)}  ${body}`);
    for (const f of r.flags) console.log(`          ${"".padEnd(qw)}  ^ ${f}`);
  }
  console.log("");
}

// ------------------------------------------------------------------ main

try {
  await offlineTests();
  if (OFFLINE) console.log("\nLive tests skipped (--offline)");
  else await liveTests();
} catch (err) {
  console.error(`\nHarness error: ${oneLine(err)}`);
  process.exitCode = 1;
}

const fmt = (r) => `${r.pass} passed, ${r.fail} failed, ${r.skip} skipped`;
console.log(`\nOffline: ${fmt(results.offline)}`);
if (!OFFLINE) console.log(`Live:    ${fmt(results.live)}`);
if (failures.length) {
  console.log(`\nFailures:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
}
