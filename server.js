const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { isPrivateIp, isPrivateHost } = require("./lib/net-guard");
const { PluginRuntime, callPlugin } = require("./lib/plugin-host");
const {
  pluginNameFromUrl,
  fetchPluginSource,
  fetchPluginSourceFromSky,
  fetchRepoPlugins,
} = require("./lib/plugin-url");

const ROOT = __dirname;
const PLUGINS_DIR = path.join(ROOT, "plugins");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "plugins.json");
const BUNDLES_FILE = path.join(DATA_DIR, "bundles.json");
fs.mkdirSync(PLUGINS_DIR, { recursive: true }); // dev/test plugins; git ignores empty dirs
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = process.env.PORT || 3999;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000;
const META_CACHE_MAX = 200;
// cap live plugin workers (each holds a ~64MB heap) — public install is
// unauthenticated by design, so the blast radius of a spray is bounded
const MAX_PLUGINS = Number(process.env.MAX_PLUGINS) || 60;
// ids are slugs: [a-z0-9_-]; reject anything else from persisted state
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
} catch (e) {
  console.error("config.json missing/invalid:", e.message);
}

// ---------- state: data/plugins.json ----------
// Dashboard-managed runtime state. When GITHUB_TOKEN is set it's mirrored to
// the repo's `state` branch and restored at boot — Render free tier wipes the
// filesystem on redeploy and idle spin-down.
let state = []; // [{id, name, url, addedAt}]

const GITHUB_REPO = process.env.GITHUB_REPO || config.githubRepo || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const STATE_BRANCH = "state";
const STATE_PATH = "data/plugins.json";

function ghHeaders() {
  return {
    Authorization: "Bearer " + GITHUB_TOKEN,
    "User-Agent": "plugin-host",
    Accept: "application/vnd.github+json",
  };
}

async function ensureStateBranch() {
  const ref = await fetch(
    "https://api.github.com/repos/" +
      GITHUB_REPO +
      "/git/ref/heads/" +
      STATE_BRANCH,
    { headers: ghHeaders() },
  );
  if (ref.ok) return;
  const repo = await (
    await fetch("https://api.github.com/repos/" + GITHUB_REPO, {
      headers: ghHeaders(),
    })
  ).json();
  if (!repo.default_branch)
    throw new Error("github api: " + (repo.message || "repo lookup failed"));
  const head = await (
    await fetch(
      "https://api.github.com/repos/" +
        GITHUB_REPO +
        "/git/ref/heads/" +
        repo.default_branch,
      { headers: ghHeaders() },
    )
  ).json();
  if (!head.object)
    throw new Error("github api: " + (head.message || "ref lookup failed"));
  await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/git/refs", {
    method: "POST",
    headers: ghHeaders(),
    body: JSON.stringify({
      ref: "refs/heads/" + STATE_BRANCH,
      sha: head.object.sha,
    }),
  });
}

async function loadStateFromGithub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return false;
  try {
    const res = await fetch(
      "https://api.github.com/repos/" +
        GITHUB_REPO +
        "/contents/" +
        STATE_PATH +
        "?ref=" +
        STATE_BRANCH,
      { headers: ghHeaders() },
    );
    if (!res.ok) return false;
    const data = await res.json();
    const parsed = JSON.parse(
      Buffer.from(data.content, "base64").toString("utf8"),
    );
    if (Array.isArray(parsed) && parsed.length) {
      state = parsed;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log("restored", state.length, "plugins from GitHub state branch");
      return true;
    }
  } catch (e) {
    console.warn("github state load failed:", e.message);
  }
  return false;
}

async function syncStateToGithub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    await ensureStateBranch();
    const content = Buffer.from(JSON.stringify(state, null, 2)).toString(
      "base64",
    );
    const cur = await fetch(
      "https://api.github.com/repos/" +
        GITHUB_REPO +
        "/contents/" +
        STATE_PATH +
        "?ref=" +
        STATE_BRANCH,
      { headers: ghHeaders() },
    );
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const res = await fetch(
      "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + STATE_PATH,
      {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify({
          message: "sync plugin state",
          content,
          sha,
          branch: STATE_BRANCH,
        }),
      },
    );
    if (!res.ok) console.warn("github sync failed:", res.status);
  } catch (e) {
    console.warn("github sync failed:", e.message);
  }
}

async function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(state)) state = [];
    if (state.length) return;
  } catch (e) {
    state = [];
  }
  // disk wiped → GitHub mirror
  await loadStateFromGithub();
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  syncStateToGithub(); // fire-and-forget; local state is already durable
}

// ---------- plugin registry ----------

const plugins = new Map(); // id -> plugin
const globalPool = { plugins, prefixMap: new Map() };

function makePlugin(id, name, code, descriptor) {
  return {
    id,
    name,
    descriptor,
    sections: new Map(),
    sectionsTs: 0,
    metaCache: new Map(),
    status: "ok",
    error: "",
    runtime: new PluginRuntime(name, code, descriptor, {
      verifyUA: descriptor.verifyUA || null,
      storageFile: path.join(DATA_DIR, "storage", id + ".json"),
    }),
  };
}

function destroyPool(pool) {
  for (const p of pool.plugins.values()) if (p.runtime) p.runtime.destroy();
}

function publicBase(req) {
  const configured = (process.env.PUBLIC_URL || config.publicUrl || "").replace(
    /\/$/,
    "",
  );
  // host-header poisoning guard: only trust the Host header when no canonical
  // public URL is configured (dev mode); otherwise use the configured URL
  if (configured) return configured;
  const host = String(req.headers.host || "localhost:" + PORT);
  const proto =
    req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted
      ? "https"
      : "http";
  return proto + "://" + host.replace(/[^\w.:-]/g, "");
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "home"
  );
}

function uniqueId(base) {
  let id = base;
  let n = 2;
  while (plugins.has(id) || state.some((e) => e.id === id))
    id = base + "-" + n++;
  return id;
}

const TYPE_MAP = {
  movie: "movie",
  movies: "movie",
  series: "series",
  tv: "series",
  tvseries: "series",
  tvshow: "series",
  tvshows: "series",
  show: "series",
  anime: "series",
  animes: "series",
  livestream: "movie",
  livetv: "movie",
  iptv: "movie",
  live: "movie",
  other: "movie",
};
function mapType(t) {
  return TYPE_MAP[String(t || "").toLowerCase()] || "movie";
}

const QUALITY_MAP = {
  2160: "4K",
  1440: "1440p",
  1080: "1080p",
  720: "720p",
  480: "480p",
  360: "360p",
};

function itemName(item) {
  return item.title || item.name || item.url || "Untitled";
}
// Stremio web runs on https: an http image URL (tmdb etc.) is blocked as
// mixed content -> blank posters. Upgrade to https; hosts like tmdb serve it.
function httpsImg(s) {
  return s ? String(s).replace(/^http:\/\//i, "https://") : s;
}
function itemPoster(item) {
  return httpsImg(item.posterUrl || item.logoUrl) || undefined;
}

function mapItem(item, sectionSlug) {
  let type = mapType(item.type);
  // plugins often label every catalog row "movie" (vegamovies card() does)
  // while the detail page is a series — a series-y section slug wins so the
  // home board doesn't show series as movies (and vice versa stays as-is)
  if (
    type === "movie" &&
    sectionSlug &&
    /series|show|drama|anime|korean|tv_|episode|ongoing|airing|cartoon/i.test(
      sectionSlug,
    )
  )
    type = "series";
  // same single-episode rule as mapMeta: a "series" with exactly one episode
  // is a movie (single-episode VOD); no episodes at all stays series
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  if (type === "series" && episodes.length === 1) type = "movie";
  return {
    id: item.url,
    type,
    name: itemName(item),
    poster: itemPoster(item),
    background: httpsImg(item.bannerUrl || item.backgroundPosterUrl) || "",
    logo: httpsImg(item.logoUrl) || "",
    description: item.description || "",
    releaseInfo: item.year ? String(item.year) : "",
    imdbRating: item.score != null ? String(item.score) : "",
  };
}

function mapCast(item) {
  const cast = item.cast || item.actors || [];
  return cast
    .map((c) => ({
      name: c.name || c.actor,
      role: c.role || c.roleString,
      image: httpsImg(c.image),
    }))
    .filter((c) => c.name);
}

// normalize an episode's season/episode numbers the same way everywhere
// (plugins leave them 0/undefined or as strings; the reference app defaults
// season 0 -> 1 and numbers episodes from 1)
function epNumbers(ep, i) {
  return {
    season: Number(ep.season) || 1,
    episode: Number(ep.episode) || i + 1,
  };
}

// Stremio's strict core (web/Android TV/Samsung/LG) requires `released` to be
// a valid RFC3339 date — a bare year ("2024"), "15.01.2024", or a number
// REJECTS the entire meta response (ERR_NO_META_FOUND, details page blank).
// Normalize to ISO or omit entirely.
function normalizeReleased(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") {
    const d = new Date(v);
    return isNaN(d) ? undefined : d.toISOString();
  }
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return s + "-01-01T00:00:00.000Z"; // bare year
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function mapMeta(item) {
  const rawType = String(item.type || "").toLowerCase();
  // trust an explicit movie/series label; only ambiguous types (anime/show/tv/
  // unset) get resolved from episode count — a multi-part movie must not be
  // forced into a series because it happens to have >1 episodes
  const isExplicitMovie =
    rawType === "movie" || rawType === "movies" || rawType === "film";
  const isExplicitSeries = [
    "series",
    "tv",
    "tvseries",
    "tvshow",
    "tvshows",
    "show",
  ].includes(rawType);
  let type = mapType(item.type);
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  if (!isExplicitMovie && !isExplicitSeries) {
    if (episodes.length > 1) type = "series";
    else if (episodes.length === 1) type = "movie";
  }
  // SkyStream parity: a series with exactly one episode is treated as a movie
  // (single-episode VOD), and livestreams are movies too
  if (type === "series" && episodes.length === 1) type = "movie";
  // build videos whenever the plugin provides episodes — SkyStream encodes
  // movies as a single "Play Movie" episode (season 1, episode 1), and series
  // plugins may label their type "tv"/"show"/"anime"/... or leave it unset
  // (defaults to "movie"), so type alone must not gate episode rendering
  const videos = episodes
    .map((ep, i) => {
      const n = epNumbers(ep, i);
      // Stremio builds the stream request from the video's id, so it must
      // embed the meta id (item.url): /stream/<type>/<metaId>:<s>:<e>.json.
      // A synthetic id like "e1x1" makes Stremio request /stream/.../e1x1.json
      // which no plugin owns -> "no streams" even though the plugin works.
      // Movies keep a plain id (no :s:e, no season/episode fields) so Stremio
      // renders them as movies, not as S01E01 of a series.
      const isMovie = type === "movie";
      return {
        id: isMovie ? item.url : item.url + ":" + n.season + ":" + n.episode,
        title: ep.name || (isMovie ? "Play" : "Episode " + n.episode),
        ...(isMovie ? {} : { season: n.season, episode: n.episode }),
        released: normalizeReleased(ep.airDate),
        thumbnail: httpsImg(ep.posterUrl),
        overview: ep.description,
      };
    })
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  // plugins may return streams directly without episodes — still give Stremio
  // one playable video so the detail page loads and streams resolve
  if (!videos.length && Array.isArray(item.streams) && item.streams.length) {
    videos.push({
      id: item.url,
      title: "Play",
      released: normalizeReleased(item.year),
      thumbnail: itemPoster(item),
      overview: item.description,
    });
  }
  return {
    id: item.url,
    type,
    name: itemName(item),
    poster: itemPoster(item),
    background: item.bannerUrl || item.backgroundPosterUrl || "",
    logo: item.logoUrl || "",
    description: item.description || "",
    releaseInfo: item.year ? String(item.year) : "",
    imdbRating: item.score != null ? String(item.score) : "",
    // never pass through imdb_id: stremio-core treats it as a link to Cinemeta
    // and merges that response into the detail page — on clients without
    // Cinemeta (or for ids Cinemeta 404s) the merge fails and the page goes
    // blank. Our meta is complete; clients must render it as-is.
    genres: item.tags || [],
    cast: mapCast(item),
    videos,
    // movies: deep link straight to streams (skip the "Play" row tap)
    ...(type === "movie"
      ? { behaviorHints: { defaultVideoId: item.url } }
      : {}),
  };
}

function transformStreamUrl(url, base) {
  if (typeof url !== "string") return url;
  if (url.startsWith("MAGIC_PROXY_v2") || url.startsWith("MAGIC_PROXY_v1"))
    return base + "/proxy/" + Buffer.from(url.slice(14)).toString("base64url");
  if (url.startsWith("MAGIC_PROXY:"))
    return base + "/proxy/" + Buffer.from(url.slice(12)).toString("base64url");
  if (url.startsWith("magic_m3u8:"))
    return base + "/proxy/" + Buffer.from(url.slice(11)).toString("base64url");
  return url;
}

function mapStream(s, base, pluginName) {
  const q = typeof s.quality === "number" ? QUALITY_MAP[s.quality] : s.quality;
  const title = [s.source && s.source !== "Auto" ? s.source : "", q]
    .filter(Boolean)
    .join(" ")
    .trim();
  const url = transformStreamUrl(s.url, base);
  const out = { url };
  if (title) out.title = title;
  // protocol: notWebReady=true unless the URL is a direct https MP4; mkv/m3u8
  // (direct or proxied) must be handled by the native players, not the web one
  const isDirectMp4 = /^https:\/\/.+\.mp4($|\?)/i.test(url);
  out.behaviorHints = { notWebReady: !isDirectMp4 };
  // plugins may require headers (Referer, cookies, app UA) to serve the file;
  // Stremio players send no headers, so route those through our proxy
  const streamHeaders =
    s.headers && Object.keys(s.headers).length ? s.headers : null;
  if (streamHeaders) {
    out.url =
      base +
      "/proxy/" +
      Buffer.from(
        JSON.stringify({ url: s.url, headers: streamHeaders }),
      ).toString("base64url");
  }
  const group = [pluginName, q || s.source].filter(Boolean).join("-");
  if (group) out.behaviorHints.bingeGroup = group;
  const fname = filenameFromUrl(s.url);
  if (fname) out.behaviorHints.filename = fname; // subtitle addons match on this
  if (Array.isArray(s.subtitles) && s.subtitles.length) {
    out.subtitles = s.subtitles.map((sub) => ({
      lang: sub.lang || sub.label || "en",
      url: sub.url,
    }));
  }
  return out;
}

function filenameFromUrl(u) {
  if (typeof u !== "string" || !/^https?:/.test(u)) return null;
  try {
    const name = decodeURIComponent(
      new URL(u).pathname.split("/").filter(Boolean).pop() || "",
    );
    return /^[a-zA-Z0-9][^\\/]{0,199}$/.test(name) ? name : null;
  } catch (e) {
    return null;
  }
}

// ---------- plugin loading ----------

// Load state entries (fetch source, install, spawn runtime) plus any
// dev/test plugin dirs dropped into plugins/ by hand.
async function loadFromState() {
  for (const p of plugins.values()) if (p.runtime) p.runtime.destroy();
  plugins.clear();
  globalPool.prefixMap.clear();
  // parallel: plugins are independent; sequential 15s timeouts would stall
  // boot for minutes when an upstream is down
  await Promise.all(
    state.map(async (entry) => {
      try {
        // ids come from persisted state (file or `state` git branch) — reject
        // anything that isn't a slug so a tampered entry can't traverse paths
        if (!ID_RE.test(entry.id || "")) {
          console.warn("skipping state entry with unsafe id:", entry.id);
          return;
        }
        const { name, code, descriptor } = entry.url.endsWith(".sky")
          ? await fetchPluginSourceFromSky(entry.url, entry.name || "")
          : await fetchPluginSource(entry.url);
        // multi-provider packages: re-inject the provider this entry represents
        const full = entry.providerId
          ? { ...descriptor, providerId: entry.providerId }
          : descriptor;
        const plugin = makePlugin(entry.id, name, code, full);
        writePluginFiles(plugin, code, full);
        plugins.set(entry.id, plugin);
        console.log("loaded plugin:", entry.id);
      } catch (e) {
        console.warn("plugin", entry.id, "failed to load:", e.message);
        plugins.set(entry.id, {
          id: entry.id,
          name: entry.name,
          descriptor: {},
          sections: new Map(),
          sectionsTs: 0,
          metaCache: new Map(),
          status: "error",
          error: e.message,
          runtime: null,
        });
      }
    }),
  );
  // dev/test: plugin dirs not managed by state (hot reload picks them up)
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || plugins.has(entry.name)) continue;
    const jsPath = path.join(PLUGINS_DIR, entry.name, "plugin.js");
    if (!fs.existsSync(jsPath)) continue;
    let descriptor = {};
    try {
      descriptor = JSON.parse(
        fs.readFileSync(
          path.join(PLUGINS_DIR, entry.name, "plugin.json"),
          "utf8",
        ),
      );
    } catch (e) {
      // plugin.json optional
    }
    const plugin = makePlugin(
      entry.name,
      entry.name,
      fs.readFileSync(jsPath, "utf8"),
      descriptor,
    );
    plugin.dir = path.join(PLUGINS_DIR, entry.name);
    plugins.set(entry.name, plugin);
    console.log("loaded dev plugin:", entry.name);
  }
}

function writePluginFiles(plugin, code, descriptor) {
  plugin.dir = path.join(PLUGINS_DIR, plugin.id);
  fs.mkdirSync(plugin.dir, { recursive: true });
  fs.writeFileSync(path.join(plugin.dir, "plugin.js"), code);
  if (descriptor && Object.keys(descriptor).length)
    fs.writeFileSync(
      path.join(plugin.dir, "plugin.json"),
      JSON.stringify(descriptor, null, 2),
    );
  lastSelfWrite = Date.now(); // management-API writes manage state directly — no hot reload
}

async function warmPlugin(plugin, pool) {
  if (!plugin.runtime) return;
  if (plugin.warming) return plugin.warming;
  plugin.warming = (async () => {
    if (plugin.sectionsTs && Date.now() - plugin.sectionsTs < CACHE_TTL_MS)
      return;
    const res = await callPlugin(plugin.runtime, "getHome", []);
    if (!res.success || !res.data || typeof res.data !== "object") {
      plugin.sectionsTs = Date.now(); // cache the failure so catalogs don't re-call on every request
      plugin.status = "error";
      plugin.error = res.message || "getHome failed";
      console.warn(
        "plugin",
        plugin.name,
        "getHome failed:",
        res.message || "no data",
      );
      return; // keep existing sections — stale catalogs beat empty ones
    }
    const sectionMap = Array.isArray(res.data)
      ? { [plugin.descriptor.name || plugin.name]: res.data }
      : res.data;
    const built = new Map();
    for (const [name, items] of Object.entries(sectionMap)) {
      if (!Array.isArray(items) || !items.length) continue;
      // plugins sometimes sprinkle null/undefined into their lists; a null
      // entry used to crash warmPlugin -> killed the whole server on add
      const clean = items.filter((i) => i && typeof i === "object");
      if (!clean.length) continue;
      const firstType = mapType(clean[0].type);
      built.set(slugify(name), { name, type: firstType, items: clean });
    }
    if (!built.size) {
      // no sections (flaky/blocked upstream) — keep existing catalogs, stale beats empty
      plugin.sectionsTs = Date.now();
      plugin.status = "error";
      plugin.error = "getHome returned no sections";
      console.warn("plugin", plugin.name, "getHome returned no sections");
      return;
    }
    // merge, don't replace: plugins drop sections whose page fetch failed at
    // warm time, so a transient upstream failure would shrink the catalog list
    // until the next good warm — keep stale sections, fresh ones win
    for (const [slug, section] of plugin.sections) {
      if (!built.has(slug)) built.set(slug, section);
    }
    plugin.sections = built;
    plugin.metaCache.clear();
    plugin.sectionsTs = Date.now();
    plugin.status = "ok";
    plugin.error = "";
    rebuildPrefixMap(pool);
    console.log(
      "plugin",
      plugin.name,
      "catalogs:",
      [...plugin.sections.keys()].join(", ") || "(none)",
    );
  })().finally(() => {
    plugin.warming = null;
  });
  return plugin.warming;
}

async function warmAll() {
  await Promise.all(
    [...plugins.values()].map((p) =>
      warmPlugin(p, globalPool).catch((e) =>
        console.warn("warm", p.name, "failed:", e.message),
      ),
    ),
  );
}

function rebuildPrefixMap(pool) {
  pool.prefixMap.clear();
  for (const p of pool.plugins.values()) {
    if (p.descriptor.idPrefix)
      pool.prefixMap.set(
        String(p.descriptor.idPrefix).replace(/\/$/, ""),
        p.id,
      );
    for (const { items } of p.sections.values()) {
      for (const item of items) {
        if (!item.url || typeof item.url !== "string") continue;
        try {
          const origin = new URL(item.url).origin;
          pool.prefixMap.set(origin, p.id);
        } catch (e) {}
      }
    }
  }
}

function pluginForId(id, pool) {
  if (!id || typeof id !== "string") return null;
  let best = null;
  for (const [prefix, name] of pool.prefixMap) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length))
      best = { prefix, name };
  }
  if (best) return pool.plugins.get(best.name);
  if (pool.plugins.size === 1) return [...pool.plugins.values()][0];
  return null;
}

// Some plugins use non-URL item ids (castle://media/..., JSON blobs like
// {"mode":"tmdb",...}) that no prefix can route. Probe: fire load(id) at all
// plugins in parallel, first one that returns a valid item wins. Result is
// cached per id (positive + short negative) so repeat requests are instant.
const probeCache = new Map(); // id -> { pluginId, ts } | { miss: true, ts }
const PROBE_TIMEOUT_MS = 15000;
const PROBE_NEGATIVE_TTL_MS = 60000;
// a failed load() is often transient (Cloudflare challenge, upstream hiccup) —
// negative-cache it briefly so the next tap retries instead of 404ing for the
// full CACHE_TTL_MS
const NEGATIVE_TTL_MS = 30000;
const PROBE_CACHE_MAX = 500;

function probeCachePut(id, value) {
  if (probeCache.size >= PROBE_CACHE_MAX) {
    let oldestKey = null,
      oldestTs = Infinity;
    for (const [k, v] of probeCache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) probeCache.delete(oldestKey);
  }
  probeCache.set(id, value);
}

async function probePluginForId(id, pool) {
  const isGlobal = pool === globalPool;
  const cached = isGlobal ? probeCache.get(id) : null;
  if (cached) {
    if (cached.pluginId) {
      const p = pool.plugins.get(cached.pluginId);
      if (p) return p;
    } else if (Date.now() - cached.ts < PROBE_NEGATIVE_TTL_MS) {
      return null;
    }
  }
  // deterministic first: the owning plugin's catalog contains this exact item
  for (const p of pool.plugins.values()) {
    for (const section of p.sections.values()) {
      if (section.items.some((it) => it && it.url === id)) {
        probeCachePut(id, { pluginId: p.id, ts: Date.now() });
        return p;
      }
    }
  }
  const candidates = [...pool.plugins.values()].filter((p) => p.runtime);
  if (!candidates.length) return null;
  // fallback: fire load(id) at all plugins; a strong match (the plugin's own
  // item url equals the requested id) resolves immediately — a few slow or
  // Cloudflare-blocked plugins must not block the whole probe until timeout
  const score = (h) =>
    (h.d.url === id ? 4 : 0) +
    (Array.isArray(h.d.episodes) && h.d.episodes.length ? 2 : 0) +
    (Array.isArray(h.d.streams) && h.d.streams.length ? 2 : 0) +
    (h.d.name && h.d.name !== "No Title" && h.d.name !== "Untitled" ? 1 : 0);
  const probeAll = new Promise((resolve) => {
    const hits = [];
    let settled = 0;
    const finish = () => {
      if (!hits.length) return resolve(null);
      hits.sort((a, b) => score(b) - score(a));
      resolve(hits[0].p);
    };
    for (const p of candidates) {
      callPlugin(p.runtime, "load", [id])
        .then((res) => {
          if (res.success && res.data && typeof res.data === "object") {
            const h = { p, d: res.data };
            if (h.d.url === id) return resolve(p); // exact owner — done
            hits.push(h);
          }
          if (++settled === candidates.length) finish();
        })
        .catch(() => {
          if (++settled === candidates.length) finish();
        });
    }
  });
  const winner = await Promise.race([
    probeAll,
    new Promise((res) => setTimeout(() => res(null), PROBE_TIMEOUT_MS)),
  ]);
  if (isGlobal)
    probeCachePut(
      id,
      winner
        ? { pluginId: winner.id, ts: Date.now() }
        : { miss: true, ts: Date.now() },
    );
  return winner;
}

function catalogList(pool) {
  const multi = pool.plugins.size > 1;
  const out = [];
  for (const p of pool.plugins.values()) {
    const label = p.descriptor.name || p.name;
    const prefix = p.descriptor.catalogPrefix || p.name;
    const extras = [
      { name: "skip", options: ["0", "1", "2", "3"] },
      { name: "genre", options: [] },
    ];
    if (p.sections.size === 0) {
      // not warmed yet: advertise the descriptor's declared catalogs so the
      // addon is visible immediately (a slow/failing getHome must not hide it)
      for (const c of p.descriptor.catalogs || []) {
        out.push({
          id: c.id || prefix + "_" + (c.name || slugify(c.id || "")),
          type: c.type || "movie",
          name: multi ? label + " • " + (c.name || c.id) : c.name || c.id,
          extra: extras,
        });
      }
      continue;
    }
    for (const [slug, section] of p.sections) {
      out.push({
        id: prefix + "_" + slug,
        type: section.type,
        name: multi ? label + " • " + section.name : section.name,
        // board-compatible: without `extra` Stremio's home board shows
        // "No home rows available ... without required extras"
        extra: extras,
      });
    }
  }
  return out;
}

function findCatalog(pool, catalogId) {
  for (const p of pool.plugins.values()) {
    const prefix = p.descriptor.catalogPrefix || p.name;
    if (catalogId.startsWith(prefix + "_")) {
      const slug = catalogId.slice(prefix.length + 1);
      const section = p.sections.get(slug);
      if (section) return { plugin: p, section, slug };
    }
    // descriptor-declared catalog (pre-warm fallback): match by exact id
    const decl = (p.descriptor.catalogs || []).find((c) => c.id === catalogId);
    if (decl) return { plugin: p, section: null, slug: decl.id };
  }
  return null;
}

// single-plugin pool for a plugin's own addon URL
function poolFor(plugin) {
  const pool = {
    plugins: new Map([[plugin.id, plugin]]),
    prefixMap: new Map(),
  };
  rebuildPrefixMap(pool);
  return pool;
}

function cachePut(map, key, ts, value, ttl) {
  if (map.size >= META_CACHE_MAX) {
    let oldestKey = null,
      oldestTs = Infinity;
    for (const [k, v] of map) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) map.delete(oldestKey);
  }
  map.set(key, { ts, value, ttl });
}

const META_TIMED_OUT = Symbol("meta-timed-out");

async function getRawItem(plugin, metaId, timeoutMs) {
  if (!plugin.runtime) return null;
  const cached = plugin.metaCache.get(metaId);
  const ttl = cached && cached.ttl ? cached.ttl : CACHE_TTL_MS;
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  const load = callPlugin(plugin.runtime, "load", [metaId]);
  // keep caching even when the caller times out: the follow-up stream request
  // then hits the cache instead of re-loading the slow upstream
  load
    .then((res) => {
      if (!res || !res.success || !res.data || typeof res.data !== "object")
        return;
      if (!res.data.url) res.data.url = metaId;
      cachePut(plugin.metaCache, metaId, Date.now(), res.data);
    })
    .catch(() => {});
  const res = timeoutMs
    ? await Promise.race([
        load,
        new Promise((r) => setTimeout(() => r(META_TIMED_OUT), timeoutMs)),
      ])
    : await load;
  if (res === META_TIMED_OUT) return null; // load still running; no negative cache
  if (!res.success || !res.data || typeof res.data !== "object") {
    // negative cache: a dead id must not re-trigger the full slow load on
    // every stream/meta request — but keep it short so a transient upstream
    // failure (Cloudflare challenge) recovers on the next tap
    cachePut(plugin.metaCache, metaId, Date.now(), null, NEGATIVE_TTL_MS);
    return null;
  }
  // SkyStream parity: plugins may omit `url` in load() results — backfill it
  // with the requested URL (movie playback depends on this)
  if (!res.data.url) res.data.url = metaId;
  return res.data;
}

// ---------- helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- management API ----------

function publicPlugin(entry, req) {
  const p = plugins.get(entry.id);
  const out = {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    status: p ? p.status : "error",
    error: p ? p.error : "not loaded",
    catalogs: [],
    addonUrl: publicBase(req) + "/" + entry.id + "/manifest.json",
    addedAt: entry.addedAt,
  };
  if (p) {
    const prefix = p.descriptor.catalogPrefix || p.name;
    out.catalogs = [...p.sections.entries()].map(([slug, s]) => ({
      id: prefix + "_" + slug,
      type: s.type,
      name: s.name,
    }));
  }
  return out;
}

function handleListPlugins(req, res) {
  sendJson(res, 200, { plugins: state.map((e) => publicPlugin(e, req)) });
}

// ---------- bundles: unique addon URLs for a user's plugin selection ----------

let bundles = []; // {id, pluginIds, createdAt}

// repo plugins registered by the client (POST /api/repos): slug -> {url, name}
const REPO_PLUGINS_FILE = path.join(DATA_DIR, "repo-plugins.json");
const repoPlugins = new Map();

function loadRepoPlugins() {
  try {
    const d = JSON.parse(fs.readFileSync(REPO_PLUGINS_FILE, "utf8"));
    if (d && typeof d === "object")
      for (const [k, v] of Object.entries(d)) repoPlugins.set(k, v);
  } catch (e) {
    // no registry yet
  }
}

function saveRepoPlugins() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    REPO_PLUGINS_FILE,
    JSON.stringify(Object.fromEntries(repoPlugins), null, 2),
  );
}

// seed the repo registry from plugins.txt (one repo.json URL per line) —
// survives disk wipes: every listed plugin's /<slug>/ URL keeps working.
// Skipped when the registry already exists (normal restart): the persisted
// registry is authoritative and boot stays fast (no 12 GitHub fetches).
async function seedReposFromFile() {
  if (repoPlugins.size) return;
  let lines = [];
  try {
    lines = fs
      .readFileSync(path.join(ROOT, "plugins.txt"), "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch (e) {
    return; // no plugins.txt — dashboard-managed repos only
  }
  await Promise.allSettled(
    lines.map(async (url) => {
      try {
        const list = await fetchRepoPlugins(url);
        for (const p of list.plugins)
          repoPlugins.set(slugify(p.name), { url: p.url, name: p.name });
        console.log(
          "seeded repo:",
          list.name,
          "(" + list.plugins.length + " plugins)",
        );
      } catch (e) {
        console.warn("repo seed failed:", url, "-", e.message);
      }
    }),
  );
  saveRepoPlugins();
}

function loadBundles() {
  try {
    bundles = JSON.parse(fs.readFileSync(BUNDLES_FILE, "utf8"));
    if (!Array.isArray(bundles)) bundles = [];
  } catch (e) {
    bundles = [];
  }
  pruneBundles();
}

function saveBundles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BUNDLES_FILE, JSON.stringify(bundles, null, 2));
}

// drop bundles whose plugins no longer exist (and dead ids inside survivors)
function pruneBundles() {
  for (const b of bundles)
    b.pluginIds = b.pluginIds.filter((x) => plugins.has(x));
  bundles = bundles.filter((b) => b.pluginIds.length);
}

function bundlePool(b) {
  const pool = { plugins: new Map(), prefixMap: new Map() };
  for (const id of b.pluginIds) {
    const p = plugins.get(id);
    if (p) pool.plugins.set(id, p);
  }
  rebuildPrefixMap(pool);
  return pool;
}

// stable id for a stateless bundle: same selection -> same id, forever
function autoBundleId(urls) {
  return crypto
    .createHash("sha1")
    .update(urls.join("\n"))
    .digest("hex")
    .slice(0, 8);
}

// shared dispatch for stateful (id-based) and stateless (url-encoded) bundles
function serveBundleDispatch(req, res, pool, manifestId, rest, query) {
  if (rest === "/manifest.json")
    return sendJson(res, 200, manifest(pool, req, manifestId));
  const proxyM = /^\/proxy\/(.+)$/.exec(rest);
  if (proxyM) return handleProxy(req, res, proxyM[1]);
  const catM = /^\/catalog\/(movie|series)\/([^/]+)(?:\/[^/]+)?\.json$/.exec(
    rest,
  );
  if (catM)
    return handleCatalog(
      req,
      res,
      catM[1],
      decodeId(catM[2]),
      (query || new URLSearchParams()).get("search"),
      pool,
    );
  const metaM = /^\/meta\/(movie|series)\/(.+)\.json$/.exec(rest);
  if (metaM) return handleMeta(req, res, metaM[1], decodeId(metaM[2]), pool);
  const streamM = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(rest);
  if (streamM)
    return handleStream(
      req,
      res,
      streamM[1],
      decodeId(streamM[2]),
      pool,
      publicBase(req),
    );
  return sendJson(res, 404, { error: "not found" });
}

function publicBundle(b, req) {
  return {
    id: b.id,
    pluginIds: b.pluginIds,
    // deterministic name-based URL: same selection → same link
    url: publicBase(req) + "/" + b.pluginIds.join("-") + "/manifest.json",
    createdAt: b.createdAt,
  };
}

function handleListBundles(req, res) {
  sendJson(res, 200, { bundles: bundles.map((b) => publicBundle(b, req)) });
}

async function handleAddBundle(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 16384));
  } catch (e) {
    return sendJson(res, 400, { error: "bad json body" });
  }
  // stateless bundle: client passes manifest URLs; plugins are installed now
  // (state survives wipes via the GitHub mirror), and the returned URL is the
  // deterministic name-based form /slug1-slug2-.../manifest.json
  if (Array.isArray(body && body.urls)) {
    const urls = body.urls
      .filter((u) => typeof u === "string" && u.trim())
      .slice(0, 20); // cap hostile payloads; bundles of 3-5 are the norm
    if (!urls.length) return sendJson(res, 400, { error: "no plugin urls" });
    const ids = [];
    for (const u of urls) {
      try {
        ids.push(await installPluginFromUrl(u));
      } catch (e) {
        console.warn("bundle skip", u, "-", e.message);
      }
    }
    if (!ids.length)
      return sendJson(res, 400, { error: "no installable plugins" });
    return sendJson(res, 201, {
      bundle: {
        id: autoBundleId(urls),
        urls,
        stateless: true,
        url: publicBase(req) + "/" + ids.join("-") + "/manifest.json",
      },
    });
  }
  const ids = Array.isArray(body && body.pluginIds)
    ? body.pluginIds.filter((id) => typeof id === "string" && plugins.has(id))
    : [];
  if (!ids.length) return sendJson(res, 400, { error: "no valid plugin ids" });
  const b = {
    id: crypto.randomBytes(8).toString("hex"),
    pluginIds: ids,
    createdAt: Date.now(),
  };
  bundles.push(b);
  saveBundles();
  sendJson(res, 201, { bundle: publicBundle(b, req) });
}

function handleDeleteBundle(req, res, id) {
  const i = bundles.findIndex((b) => b.id === id);
  if (i === -1) return sendJson(res, 200, { ok: true }); // already pruned — idempotent
  bundles.splice(i, 1);
  saveBundles();
  sendJson(res, 200, { ok: true });
}

// POST /api/plugins {url} — fetch + install a plugin, return its addon URL
// install a plugin from its manifest url (idempotent: reuses the installed
// entry when present). Shared by POST /api/plugins and stateless bundles.
const installing = new Map(); // url -> Promise<id>, single-flight per url
// installs are rare and id allocation + state push must be atomic (two
// different URLs with the same plugin name would otherwise collide on the id)
let installChain = Promise.resolve();
function withInstallLock(fn) {
  const run = installChain.then(fn, fn);
  installChain = run.catch(() => {});
  return run;
}
async function installPluginFromUrl(url, name = "") {
  const existing = state.find((e) => e.url === url);
  if (existing && plugins.has(existing.id)) return existing.id;
  if (installing.has(url)) return installing.get(url);
  const job = withInstallLock(async () => {
    // re-check under the lock: a concurrent install of the same url may have
    // completed while we waited
    const done = state.find((e) => e.url === url);
    if (done && plugins.has(done.id)) return done.id;
    const source = url.endsWith(".sky")
      ? await fetchPluginSourceFromSky(url, name)
      : await fetchPluginSource(url);
    const providers =
      Array.isArray(source.descriptor.providers) &&
      source.descriptor.providers.length
        ? source.descriptor.providers
        : null;
    if (providers) {
      // multi-provider package (netmirror/vegamovies/piratexplay style): one
      // addon per provider, ALL enabled by default — SkyStream parity. The
      // plugin reads manifest.providerId to pick its source.
      const seen = new Set();
      const ids = [];
      for (const p of providers) {
        if (!p || !p.id || seen.has(p.id)) continue;
        seen.add(p.id);
        if (plugins.size >= MAX_PLUGINS) {
          console.warn(
            "max plugins (" + MAX_PLUGINS + ") reached, skipping",
            p.id,
          );
          break;
        }
        const pname = p.name || source.name + " " + p.id;
        const baseId = slugify(source.name) + "-" + slugify(p.id);
        const id = uniqueId(baseId);
        const descriptor = { ...source.descriptor, providerId: p.id };
        const plugin = makePlugin(id, pname, source.code, descriptor);
        const pool = poolFor(plugin);
        await warmPlugin(plugin, pool).catch((e) => {
          plugin.status = "error";
          plugin.error = e.message;
          console.warn("warm", plugin.name, "failed:", e.message);
        });
        writePluginFiles(plugin, source.code, descriptor);
        state.push({
          id,
          name: pname,
          url,
          providerId: p.id,
          addedAt: Date.now(),
        });
        saveState();
        plugins.set(id, plugin);
        ids.push(id);
        console.log("added plugin:", id, "(provider:", p.id + ") <-", url);
      }
      rebuildPrefixMap(globalPool);
      if (!ids.length) throw new Error("no providers could be installed");
      return ids[0];
    }
    if (plugins.size >= MAX_PLUGINS)
      throw new Error("max plugins (" + MAX_PLUGINS + ") reached");
    const id = uniqueId(slugify(source.name));
    const plugin = makePlugin(id, source.name, source.code, source.descriptor);
    const pool = poolFor(plugin);
    await warmPlugin(plugin, pool).catch((e) => {
      plugin.status = "error";
      plugin.error = e.message;
      console.warn("warm", plugin.name, "failed:", e.message);
    });
    writePluginFiles(plugin, source.code, source.descriptor);
    state.push({ id, name: source.name, url, addedAt: Date.now() });
    saveState();
    plugins.set(id, plugin);
    rebuildPrefixMap(globalPool);
    console.log("added plugin:", id, "<-", url);
    return id;
  });
  installing.set(url, job);
  try {
    return await job;
  } finally {
    installing.delete(url);
  }
}

async function handleAddPlugin(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 16384));
  } catch (e) {
    return sendJson(res, 400, { error: "bad json body" });
  }
  const url = body && typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return sendJson(res, 400, { error: "missing url" });
  if (state.some((e) => e.url === url))
    return sendJson(res, 409, { error: "plugin already added" });
  let id;
  try {
    id = await installPluginFromUrl(
      url,
      typeof body.name === "string" ? body.name : "",
    );
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const entry = state.find((e) => e.id === id);
  sendJson(res, 201, { plugin: publicPlugin(entry, req) });
}

// POST /api/repos {url} — fetch a SkyStream repo.json and list its plugins
// (does NOT install anything; the client picks what to add)
async function handleListRepo(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 16384));
  } catch (e) {
    return sendJson(res, 400, { error: "bad json body" });
  }
  const url = body && typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return sendJson(res, 400, { error: "missing url" });
  try {
    const list = await fetchRepoPlugins(url);
    // remember repo plugins so their predicted per-plugin addon URLs
    // (/<slug>/manifest.json) auto-install on first access — the card shows
    // that URL, not the raw .sky build link
    for (const p of list.plugins) {
      repoPlugins.set(slugify(p.name), { url: p.url, name: p.name });
    }
    saveRepoPlugins();
    sendJson(res, 200, list);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// DELETE /api/plugins/:id — stop the runtime, drop the files, forget it
function handleDeletePlugin(req, res, id) {
  const idx = state.findIndex((e) => e.id === id);
  if (idx < 0) return sendJson(res, 404, { error: "plugin not found" });
  const plugin = plugins.get(id);
  if (plugin && plugin.runtime) plugin.runtime.destroy();
  plugins.delete(id);
  fs.rmSync(path.join(PLUGINS_DIR, id), { recursive: true, force: true });
  state.splice(idx, 1);
  saveState();
  pruneBundles();
  saveBundles();
  rebuildPrefixMap(globalPool);
  console.log("removed plugin:", id);
  sendJson(res, 200, { ok: true });
}

// ---------- addon handlers ----------

function manifest(pool, req, idOverride) {
  // self-heal: stale empty catalogs kick a background warm (Render idle spin-down)
  for (const p of pool.plugins.values()) {
    if (!p.sections.size && Date.now() - p.sectionsTs > CACHE_TTL_MS) {
      warmAll().catch(() => {});
      break;
    }
  }
  return {
    id: idOverride || config.id || "com.stremio.addon",
    name: config.name || "Stremio Addon",
    description: config.description || "",
    logo: config.logo || "",
    version: "0.1.0",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: catalogList(pool),
  };
}

async function handleCatalog(req, res, type, catalogId, search, pool) {
  let found = findCatalog(pool, catalogId);
  let items = [];
  const q = new URLSearchParams((req.url || "").split("?")[1] || "");
  const skip = Math.max(0, Number(q.get("skip")) || 0);
  const genre = (q.get("genre") || "").trim();
  if (search) {
    // Stremio's global search hits /catalog/<type>/top.json?search=... (and any
    // other unknown id) — route it to the pool's plugins' search and merge
    const targets = found ? [found.plugin] : [...pool.plugins.values()];
    const seen = new Set();
    for (const p of targets) {
      if (!p.runtime) continue;
      // plugins may export search or getSearch (CloudStream naming)
      const fn = p.api.includes("search")
        ? "search"
        : p.api.includes("getSearch")
          ? "getSearch"
          : null;
      if (!fn) continue;
      const r = await callPlugin(p.runtime, fn, [search]);
      if (!r.success || !Array.isArray(r.data)) {
        console.warn(
          "plugin",
          p.name,
          "search failed:",
          r.message || "no data",
        );
        continue;
      }
      for (const item of r.data) {
        if (!item || !item.url || mapType(item.type) !== type) continue;
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        items.push(item);
      }
    }
  } else {
    if (!found)
      return sendJson(res, 404, { error: "unknown catalog: " + catalogId });
    if (Date.now() - found.plugin.sectionsTs > CACHE_TTL_MS)
      await warmPlugin(found.plugin, pool);
    // descriptor-declared catalog not warmed yet: warm again (sections are
    // populated by the warm above) and fall back to an empty list
    if (!found.section) found = findCatalog(pool, catalogId);
    items = found.section ? found.section.items : [];
    // honor the extras the manifest advertises (skip pagination + genre)
    if (genre) {
      const g = genre.toLowerCase();
      items = items.filter((it) =>
        (it.tags || []).some((t) => String(t).toLowerCase().includes(g)),
      );
    }
    if (skip > 0) items = items.slice(skip, skip + 20);
  }
  sendJson(res, 200, {
    metas: items
      .map((it) => mapItem(it, found && found.slug))
      .filter((m) => m.id),
  });
}

// ids travel encoded, sometimes double-encoded (proxies re-encode); canonicalize
function decodeId(raw) {
  let id = decodeURIComponent(raw);
  // Nuvio (and some clients) send ids double-encoded — decode again only
  // while it still isn't a usable URL; a decoded URL's own %-escapes (query
  // strings in JSON-blob ids) must never be re-decoded
  while (!id.includes("://") && /%[0-9a-fA-F]{2}/.test(id)) {
    try {
      const d = decodeURIComponent(id);
      if (d === id) break;
      id = d;
    } catch (e) {
      break;
    }
  }
  return id;
}

// Meta is served entirely from the plugin's own load() data — the plugins are
// standalone (own catalogs, own meta, own streams), like Dramayo/Muvibox/IPTV
// addons. No Cinemeta coupling: no mirroring, no gap-filling.
// Nuvio caps meta requests at 5s (FETCH_TIMEOUT_MS in its MetaDetailsRepository)
// — a slow plugin load must not blank the detail page. Fall back to the
// catalog item (in-memory, instant) with one playable video; the background
// load keeps running and caches, so the follow-up stream request is complete.
const META_FAST_MS = 3000;

function catalogItemFor(plugin, id) {
  for (const section of plugin.sections.values())
    for (const item of section.items)
      if (item.url === id)
        return {
          ...item,
          episodes: [{ name: "Play", url: id }],
        };
  return null;
}

async function handleMeta(req, res, type, id, pool) {
  let plugin = pluginForId(id, pool);
  if (!plugin) plugin = await probePluginForId(id, pool);
  if (!plugin) return sendJson(res, 404, { error: "no plugin for id: " + id });
  let item = await getRawItem(plugin, id, META_FAST_MS);
  if (!item) item = catalogItemFor(plugin, id);
  if (!item) return sendJson(res, 404, { error: "meta not found" });
  sendJson(res, 200, { meta: mapMeta(item) });
}

async function resolveStreams(plugin, metaId, season, episode) {
  if (!plugin.runtime) return [];
  let raw = [];
  if (season !== null) {
    const item = await getRawItem(plugin, metaId);
    if (item && Array.isArray(item.episodes)) {
      const idx = item.episodes.findIndex((e, i) => {
        const n = epNumbers(e, i);
        return n.season === season && n.episode === episode;
      });
      if (idx >= 0) {
        const ep = item.episodes[idx];
        const r = await callPlugin(plugin.runtime, "loadStreams", [
          ep.url || metaId,
        ]);
        if (r.success && Array.isArray(r.data)) raw = r.data;
      }
    }
  } else {
    const item = await getRawItem(plugin, metaId);
    if (item) {
      if (Array.isArray(item.streams) && item.streams.length) {
        raw = item.streams;
      } else if (Array.isArray(item.episodes) && item.episodes.length) {
        const r = await callPlugin(plugin.runtime, "loadStreams", [
          item.episodes[0].url || metaId,
        ]);
        if (r.success && Array.isArray(r.data)) raw = r.data;
      }
    }
    if (!raw.length) {
      const r = await callPlugin(plugin.runtime, "loadStreams", [metaId]);
      if (r.success && Array.isArray(r.data)) raw = r.data;
    }
  }
  return raw;
}
async function handleStream(req, res, type, id, pool, base) {
  // SkyStream convention: series video ids are <metaId>:<season>:<episode>.
  // Try the split interpretation FIRST (anikage http ids, netmirror JSON-blob
  // ids), then the full id as a movie — probing with the unsplit id first lets
  // a plugin "successfully" load garbage for the suffix and win the probe.
  const m = /^(.*):(\d+):(\d+)$/.exec(id);
  if (m) {
    const metaId = m[1];
    const season = +m[2];
    const episode = +m[3];
    let p = pluginForId(metaId, pool);
    if (!p) p = await probePluginForId(metaId, pool);
    if (p) {
      const raw = await resolveStreams(p, metaId, season, episode);
      if (raw.length) return sendStreams(res, raw, base, p.name);
    }
  }
  // full-id interpretation: a movie, or an id that genuinely ends in
  // :digits:digits (rare) — the split above failed to produce streams
  let plugin = pluginForId(id, pool);
  if (!plugin) plugin = await probePluginForId(id, pool);
  if (plugin) {
    const raw = await resolveStreams(plugin, id, null, null);
    if (raw.length) return sendStreams(res, raw, base, plugin.name);
  }
  // empty is common when an upstream Cloudflare-challenges our datacenter IP
  // and the plugin swallows the failure — log it so it's visible in server logs
  console.warn(
    "no streams for",
    type,
    id.slice(0, 120),
    plugin ? "via " + plugin.name + " (empty result)" : "(no plugin matched)",
  );
  return sendJson(res, 404, { error: "no streams found" });
}

function sendStreams(res, raw, base, pluginName) {
  sendJson(res, 200, {
    streams: raw
      .filter((s) => s && s.url)
      .map((s) => mapStream(s, base, pluginName)),
  });
}

// ---------- magic-URL proxy ----------

// fetch with per-hop SSRF check and no silent cross-host redirects
async function fetchSafe(url, headers, maxHops, signal) {
  maxHops = maxHops || 5;
  let cur = url;
  for (let i = 0; i < maxHops; i++) {
    let u;
    try {
      u = new URL(cur);
    } catch (e) {
      throw new Error("invalid url");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:")
      throw new Error("bad scheme");
    if (await isPrivateHost(u.hostname)) throw new Error("blocked host");
    const res = await fetch(cur, { headers, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      cur = new URL(loc, cur).href;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function proxyFetch(url, extraHeaders, req, res) {
  const headers = { ...extraHeaders };
  if (!headers["User-Agent"] && !headers["user-agent"])
    headers["User-Agent"] = DEFAULT_UA;
  if (!headers["Accept-Encoding"] && !headers["accept-encoding"])
    headers["Accept-Encoding"] = "identity";
  if (req.headers.range) headers["Range"] = req.headers.range;
  const isHead = req.method === "HEAD";
  const ctrl = new AbortController(); // bound streaming proxies; requestTimeout is the backstop
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const upstream = await fetchSafe(
      url,
      {
        ...headers,
        method: isHead ? "HEAD" : "GET",
      },
      5,
      ctrl.signal,
    );
    const outHeaders = {
      "Content-Type":
        upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'", // proxied bytes: never treat as page
    };
    // forward Content-Length only when the body wasn't decompressed
    const enc = upstream.headers.get("content-encoding");
    if (upstream.headers.get("content-length") && !enc)
      outHeaders["Content-Length"] = upstream.headers.get("content-length");
    if (upstream.headers.get("content-range"))
      outHeaders["Content-Range"] = upstream.headers.get("content-range");
    if (upstream.headers.get("accept-ranges"))
      outHeaders["Accept-Ranges"] = upstream.headers.get("accept-ranges");
    res.writeHead(upstream.status, outHeaders);
    if (isHead || !upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", () => res.end()); // upstream dropped mid-body → don't crash the process
    res.on("close", () => stream.destroy());
    res.on("error", () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent)
      sendJson(res, 502, { error: "proxy fetch failed: " + e.message });
    else res.end();
  } finally {
    clearTimeout(timer);
  }
}

async function handleProxy(req, res, payloadPath) {
  let payload;
  try {
    payload = decodeURIComponent(payloadPath);
  } catch (e) {
    return sendJson(res, 400, { error: "bad proxy payload" });
  }
  let decoded;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
    if (!decoded && payload)
      decoded = Buffer.from(payload, "base64").toString("utf8");
  } catch (e) {
    return sendJson(res, 400, { error: "bad proxy payload" });
  }
  if (!decoded) return sendJson(res, 400, { error: "bad proxy payload" });
  const base = publicBase(req);

  if (decoded.startsWith("#EXTM3U")) {
    // rewrite magic-wrapped segment URIs to this proxy
    const rewritten = decoded
      .split("\n")
      .map((line) => {
        if (
          line.startsWith("MAGIC_PROXY_v2") ||
          line.startsWith("MAGIC_PROXY_v1")
        )
          return (
            base + "/proxy/" + Buffer.from(line.slice(14)).toString("base64url")
          );
        if (line.startsWith("MAGIC_PROXY:"))
          return (
            base + "/proxy/" + Buffer.from(line.slice(12)).toString("base64url")
          );
        return line;
      })
      .join("\n");
    res.writeHead(200, {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(rewritten);
  }

  let url,
    extraHeaders = {};
  if (decoded.startsWith("{")) {
    try {
      const spec = JSON.parse(decoded);
      url = spec.url;
      if (spec.headers)
        for (const [k, v] of Object.entries(spec.headers))
          if (v != null) extraHeaders[k] = String(v);
      if (spec.options && spec.options.referer)
        extraHeaders["Referer"] = spec.options.referer;
    } catch (e) {
      return sendJson(res, 400, { error: "bad proxy payload" });
    }
  } else {
    url = decoded;
  }
  if (!url || typeof url !== "string" || !/^https?:\/\//.test(url))
    return sendJson(res, 400, { error: "bad proxy url" });
  if (!extraHeaders["Referer"]) {
    try {
      extraHeaders["Referer"] = new URL(url).origin + "/";
    } catch (e) {
      // invalid url; fetchSafe reports it
    }
  }
  await proxyFetch(url, extraHeaders, req, res);
}

// ---------- static dashboard ----------

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

function serveStatic(req, res, url) {
  const entry = STATIC_FILES[url];
  if (!entry) return false;
  const file = path.join(ROOT, "public", entry.file);
  if (!fs.existsSync(file)) {
    sendJson(res, 500, { error: "dashboard files missing" });
    return true;
  }
  res.writeHead(200, {
    "Content-Type": entry.type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'",
  });
  res.end(fs.readFileSync(file));
  return true;
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const query = new URLSearchParams(req.url.split("?")[1] || "");
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }

    // ---- management API (public: this is a public plugin host) ----
    if (url === "/api/plugins" && req.method === "GET")
      return handleListPlugins(req, res);
    if (url === "/api/plugins" && req.method === "POST")
      return handleAddPlugin(req, res);
    if (url === "/api/repos" && req.method === "POST")
      return handleListRepo(req, res);
    const delM = /^\/api\/plugins\/([A-Za-z0-9_-]+)$/.exec(url);
    if (delM && req.method === "DELETE")
      return handleDeletePlugin(req, res, delM[1]);
    if (url === "/api/bundles" && req.method === "GET")
      return handleListBundles(req, res);
    if (url === "/api/bundles" && req.method === "POST")
      return handleAddBundle(req, res);
    const delBM = /^\/api\/bundles\/([a-f0-9]{16})$/.exec(url);
    if (delBM && req.method === "DELETE")
      return handleDeleteBundle(req, res, delBM[1]);

    // ---- dashboard ----
    if (url === "/" || url === "/index.html") {
      return serveStatic(req, res, "/");
    }
    if (serveStatic(req, res, url)) return;

    // ---- bundles: unique addon URLs for a user's plugin selection ----
    const bundleM = /^\/bundle\/([a-f0-9]{16})\/(.+)$/.exec(url);
    if (bundleM) {
      const b = bundles.find((x) => x.id === bundleM[1]);
      if (!b) return sendJson(res, 404, { error: "bundle not found" });
      return serveBundleDispatch(
        req,
        res,
        bundlePool(b),
        config.id + "-bundle-" + b.id,
        "/" + bundleM[2],
        query,
      );
    }
    // stateless bundle: the URL carries the plugin manifest URLs, so it
    // survives state wipes (Render ephemeral disk). Plugins are (re)installed
    // on demand from their original manifests — first hit after a wipe is
    // slow, later hits use the in-memory plugins map.
    const autoM = /^\/bundle\/auto\/([A-Za-z0-9_-]+)\/(.+)$/.exec(url);
    if (autoM) {
      let urls;
      try {
        urls = JSON.parse(Buffer.from(autoM[1], "base64url").toString());
      } catch (e) {
        urls = null;
      }
      if (!Array.isArray(urls) || !urls.length)
        return sendJson(res, 400, { error: "bad bundle payload" });
      const ids = [];
      for (const u of urls) {
        if (typeof u !== "string") continue;
        try {
          ids.push(await installPluginFromUrl(u));
        } catch (e) {
          console.warn("bundle skip", u, "-", e.message);
        }
      }
      if (!ids.length)
        return sendJson(res, 404, {
          error: "no installable plugins in bundle",
        });
      return serveBundleDispatch(
        req,
        res,
        bundlePool({ id: autoBundleId(urls), pluginIds: ids }),
        config.id + "-bundle-" + autoBundleId(urls),
        "/" + autoM[2],
        query,
      );
    }

    // ---- per-plugin addon URLs: /<id-or-slug-selection>/<route> ----
    // A selection (<slug1>-<slug2>-…) is served from one combined pool. The
    // URL is deterministic: same selection -> same link, restart-proof (the
    // registry is re-seeded from plugins.txt at every boot).
    const pluginM = /^\/([A-Za-z0-9_-]{1,64})\/(.+)$/.exec(url);
    if (pluginM) {
      const seg = pluginM[1];
      const rest = "/" + pluginM[2];
      if (!plugins.has(seg)) {
        // repo-listed plugin not installed yet: auto-install on first access
        // so the predicted addon URL (/<slug>/manifest.json) works as-is
        const rp = repoPlugins.get(seg);
        if (rp) {
          try {
            await installPluginFromUrl(rp.url);
          } catch (e) {
            console.warn("auto-install skip", rp.url, "-", e.message);
          }
        }
      }
      if (plugins.has(seg)) {
        const plugin = plugins.get(seg);
        const pool = poolFor(plugin);
        const base = publicBase(req) + "/" + seg;
        if (rest === "/manifest.json")
          return sendJson(res, 200, manifest(pool, req));
        const proxyM = /^\/proxy\/(.+)$/.exec(rest);
        if (proxyM) return handleProxy(req, res, proxyM[1]);
        const catM =
          /^\/catalog\/(movie|series)\/([^/]+)(?:\/[^/]+)?\.json$/.exec(rest);
        if (catM)
          return handleCatalog(
            req,
            res,
            catM[1],
            decodeId(catM[2]),
            query.get("search"),
            pool,
          );
        const metaM = /^\/meta\/(movie|series)\/(.+)\.json$/.exec(rest);
        if (metaM)
          return handleMeta(req, res, metaM[1], decodeId(metaM[2]), pool);
        const streamM = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(rest);
        if (streamM)
          return handleStream(
            req,
            res,
            streamM[1],
            decodeId(streamM[2]),
            pool,
            base,
          );
        return sendJson(res, 404, { error: "not found" });
      }
      // multi-provider .sky installs as <slug>-<provider>: point the request
      // at the first provider addon
      const alt = [...plugins.keys()].find((k) => k.startsWith(seg + "-"));
      if (alt)
        return res
          .writeHead(302, { Location: "/" + alt + "/" + pluginM[2] })
          .end();
      // combined selection: every dash-separated part is an installed id or a
      // repo slug — missing ones are auto-installed, then served from one pool
      if (seg.includes("-")) {
        const ids = [];
        for (const part of seg.split("-")) {
          if (plugins.has(part)) {
            ids.push(part);
            continue;
          }
          const rp = repoPlugins.get(part);
          if (!rp) break;
          try {
            await installPluginFromUrl(rp.url);
          } catch (e) {
            console.warn("auto-install skip", rp.url, "-", e.message);
          }
          const found = [...plugins.keys()].filter(
            (k) => k === part || k.startsWith(part + "-"),
          );
          if (!found.length) break;
          ids.push(...found);
        }
        if (ids.length > 1) {
          const pool = bundlePool({ pluginIds: [...new Set(ids)] });
          return serveBundleDispatch(req, res, pool, seg, rest, query);
        }
      }
    }

    // ---- default addon (all plugins) ----
    if (url === "/manifest.json")
      return sendJson(res, 200, manifest(globalPool, req));
    const proxyM = /^\/proxy\/(.+)$/.exec(url);
    if (proxyM) return handleProxy(req, res, proxyM[1]);
    const catM = /^\/catalog\/(movie|series)\/([^/]+)(?:\/[^/]+)?\.json$/.exec(
      url,
    );
    if (catM)
      return handleCatalog(
        req,
        res,
        catM[1],
        decodeId(catM[2]),
        query.get("search"),
        globalPool,
      );
    const metaM = /^\/meta\/(movie|series)\/(.+)\.json$/.exec(url);
    if (metaM)
      return handleMeta(req, res, metaM[1], decodeId(metaM[2]), globalPool);
    const streamM = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(url);
    if (streamM)
      return handleStream(
        req,
        res,
        streamM[1],
        decodeId(streamM[2]),
        globalPool,
        publicBase(req),
      );
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("request error:", e);
    sendJson(res, 500, { error: e.message || "internal error" });
  }
});

// hot reload (dev/test only): reload + re-warm on plugin/ changes. Writes by
// the management API set lastSelfWrite and are skipped. Off in production —
// there the API is the only writer, and a reload re-warms every plugin, so a
// flaky upstream would wipe the catalogs the add flow just built.
let booting = true;
let lastSelfWrite = 0;
let reloadTimer = null;
let reloadChain = Promise.resolve();
const reloadNow = () => {
  if (booting || Date.now() - lastSelfWrite < 1000) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadChain = reloadChain
      .then(async () => {
        console.log("plugins changed — reloading");
        await loadFromState();
        await warmAll();
      })
      .catch((e) => console.warn("reload failed:", e.message));
  }, 500);
};
if (process.env.NODE_ENV !== "production") {
  const watcher = fs.watch(PLUGINS_DIR, { recursive: true }, () => reloadNow());
  // a plugin dir removed mid-watch makes the recursive watcher throw ENOENT
  // and crash the whole server — ignore it, reloadNow() handles the change
  watcher.on("error", (e) => {
    if (e && e.code === "ENOENT") return;
    console.warn("plugin dir watcher error:", e && e.message);
  });
}

async function boot() {
  await loadState();
  await loadFromState();
  loadBundles();
  loadRepoPlugins();
  // awaited: the first request may hit a repo slug right after boot, and the
  // seed must have populated the registry by then (parallel, ~2-5s total)
  await seedReposFromFile();
  booting = false;
  server.listen(PORT, () => {
    console.log("addon listening on http://localhost:" + PORT);
    console.log("dashboard: http://localhost:" + PORT + "/");
  });
  // warm in the background — slow plugins (token-minting getHome can take
  // ~60s) must not delay boot past Render's deploy timeout
  warmAll().catch((e) => console.warn("boot warm failed:", e.message));
}

// refresh catalogs periodically so the manifest stays current
setInterval(() => warmAll().catch(() => {}), 30 * 60 * 1000).unref();

function shutdown() {
  console.log("shutting down");
  server.close();
  destroyPool(globalPool);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// router does `return handler(req, res)` — a rejection there bypasses the
// try/catch and would crash the whole server (unhandled rejection). Log it
// and keep serving; the request already got its 500 via the handler's own
// error paths where possible.
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection:", e && e.stack ? e.stack : e);
});
server.on("error", (e) => {
  console.error("server error:", e);
  if (e.code === "EADDRINUSE") process.exit(1);
});

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});
