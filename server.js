// Stateless plugin bridge: serves the Stremio addon protocol backed by remote
// .sky plugin bundles. No installs, no state files, no worker threads — every
// request resolves the plugin (slug config or URL in the path), loads its
// source (cached), evaluates it in a vm sandbox, and calls the matching global
// (getHome/load/loadStreams/search). Runs anywhere Node runs: Render/Railway/
// Fly/VPS (node server.js) and Vercel serverless (api/bridge.js + vercel.json).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { isPrivateHost } = require("./lib/net-guard");
const { parseHtml, parse_html, unpackJs } = require("./lib/mini-dom");
const { fetchPluginSourceFromSky, listPluginsInGithub } = require("./lib/plugin-url");

const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL_MS = 30 * 60 * 1000; // getHome sections cache
const META_FAST_MS = 3000; // Nuvio caps meta at 5s incl. connection — never wait longer
const NEGATIVE_TTL_MS = 60 * 1000;
const SOURCE_TTL_MS = 60 * 60 * 1000; // .sky source cache
const META_TIMED_OUT = Symbol("meta.timed.out");

// ---------- config ----------

function loadConfig() {
  // plugins.txt: one "slug URL" per line (# comments and blank lines allowed)
  for (const p of [
    path.join(__dirname, "plugins.txt"),
    path.join(process.cwd(), "plugins.txt"),
  ]) {
    try {
      const out = [];
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const [id, url] = t.split(/\s+/);
        if (id && url) out.push({ id, url });
      }
      return out;
    } catch (e) {}
  }
  return [];
}
const CONFIG = loadConfig();
const configById = new Map(CONFIG.map((e) => [e.id, e]));

// ---------- helpers ----------

function publicBase(req) {
  const configured = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  if (configured) return configured;
  const host = String(req.headers.host || "localhost:" + PORT);
  const proto =
    req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted
      ? "https"
      : "http";
  return proto + "://" + host.replace(/[^\w.:-]/g, "");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "home"
  );
}

// clients (Nuvio, Stremio) percent-encode the id exactly once — decode once.
function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return raw;
  }
}

const TYPE_MAP = {
  movie: "movie",
  movies: "movie",
  film: "movie",
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
function httpsImg(s) {
  return s ? String(s).replace(/^http:\/\//i, "https://") : s;
}
function itemPoster(item) {
  return httpsImg(item.posterUrl || item.logoUrl) || undefined;
}

function mapItem(item, sectionSlug) {
  let type = mapType(item.type);
  // plugins often label every catalog row "movie" while the detail page is a
  // series — a series-y section slug wins so the home board shows it as series
  if (
    type === "movie" &&
    sectionSlug &&
    /series|show|drama|anime|korean|tv_|episode|ongoing|airing|cartoon/i.test(
      sectionSlug,
    )
  )
    type = "series";
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

function epNumbers(ep, i) {
  return {
    season: Number(ep.season) || 1,
    episode: Number(ep.episode) || i + 1,
  };
}

function normalizeReleased(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") {
    const d = new Date(v);
    return isNaN(d) ? undefined : d.toISOString();
  }
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return s + "-01-01T00:00:00.000Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function mapMeta(item) {
  const rawType = String(item.type || "").toLowerCase();
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
  // SkyStream parity: a series with exactly one episode is a movie (VOD)
  if (type === "series" && episodes.length === 1) type = "movie";
  const videos = episodes
    .map((ep, i) => {
      const n = epNumbers(ep, i);
      // stream ids embed the meta id (item.url) so clients request
      // /stream/.../<url>:<s>:<e>.json; movies keep a plain id
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
  // plugins may return streams directly without episodes — still give the
  // client one playable video so the detail page loads and streams resolve
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
    genres: item.tags || [],
    cast: mapCast(item),
    videos,
    ...(type === "movie"
      ? { behaviorHints: { defaultVideoId: item.url } }
      : {}),
  };
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

// Streams are returned DIRECT (no proxy wrapper): the upstream CDNs serve
// without special headers (verified for movieblast), so the player fetches
// straight from the CDN — no server bandwidth, no response-size limits, works
// on any host. Only m3u8 playlists go through the proxy: their segment lines
// are MAGIC_PROXY-wrapped by the plugin and must be rewritten.
function mapStream(s, base, pluginName) {
  const q = typeof s.quality === "number" ? QUALITY_MAP[s.quality] : s.quality;
  const title = [s.source && s.source !== "Auto" ? s.source : "", q]
    .filter(Boolean)
    .join(" ")
    .trim();
  let url = String(s.url || "");
  if (/\.m3u8(\?|$)/i.test(url))
    url =
      base +
      "/proxy/" +
      Buffer.from(JSON.stringify({ url, headers: s.headers || {} })).toString(
        "base64url",
      );
  const out = { url };
  if (title) out.title = title;
  // protocol: notWebReady=true unless the URL is a direct https MP4
  out.behaviorHints = {
    notWebReady: !/^https:\/\/.+\.mp4($|\?)/i.test(url),
  };
  const group = [pluginName, q || s.source].filter(Boolean).join("-");
  if (group) out.behaviorHints.bingeGroup = group;
  const fname = filenameFromUrl(url);
  if (fname) out.behaviorHints.filename = fname;
  if (Array.isArray(s.subtitles) && s.subtitles.length) {
    out.subtitles = s.subtitles.map((sub) => ({
      lang: sub.lang || sub.label || "en",
      url: sub.url,
    }));
  }
  return out;
}
// ---------- plugin runtime (in-process vm sandbox) ----------

// plugins are untrusted: never let them reach loopback/link-local/metadata
async function httpRequest(method, url, headers, body) {
  const DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  const MAX_BODY_BYTES = 10 * 1024 * 1024;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const h = {};
    if (headers)
      for (const [k, v] of Object.entries(headers))
        if (v !== undefined && v !== null) h[k] = String(v);
    if (!h["User-Agent"] && !h["user-agent"]) h["User-Agent"] = DEFAULT_UA;
    if (!h["Accept-Encoding"] && !h["accept-encoding"])
      h["Accept-Encoding"] = "identity";
    if (
      (method === "POST" || method === "PUT") &&
      body &&
      !h["Content-Type"] &&
      !h["content-type"]
    )
      h["Content-Type"] = "application/x-www-form-urlencoded";
    let cur = url;
    let finalUrl = url;
    for (let hop = 0; hop < 5; hop++) {
      let u;
      try {
        u = new URL(cur);
      } catch (e) {
        return {
          code: 0,
          statusCode: 0,
          status: 0,
          body: "",
          error: "invalid url",
        };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:")
        return {
          code: 0,
          statusCode: 0,
          status: 0,
          body: "",
          error: "bad scheme",
        };
      if (await isPrivateHost(u.hostname))
        return {
          code: 0,
          statusCode: 0,
          status: 0,
          body: "",
          error: "blocked host",
        };
      const res = await fetch(cur, {
        method,
        headers: h,
        body: body || undefined,
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc)
          return {
            code: 0,
            statusCode: 0,
            status: 0,
            body: "",
            error: "redirect without location",
          };
        cur = new URL(loc, cur).toString();
        finalUrl = cur;
        continue;
      }
      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_BODY_BYTES)
        return {
          code: 0,
          statusCode: 0,
          status: 0,
          body: "",
          error: "response too large",
        };
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES)
        return {
          code: 0,
          statusCode: 0,
          status: 0,
          body: "",
          error: "response too large",
        };
      const outHeaders = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = outHeaders[k] ? outHeaders[k] + "," + v : v;
      });
      return {
        code: res.status,
        statusCode: res.status,
        status: res.status,
        body: text,
        headers: outHeaders,
        finalUrl,
      };
    }
    return {
      code: 0,
      statusCode: 0,
      status: 0,
      body: "",
      error: "too many redirects",
    };
  } catch (e) {
    return {
      code: 0,
      statusCode: 0,
      status: 0,
      body: "",
      error: String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function http_get(url, headers, cb) {
  return httpRequest("GET", url, headers, null).then((res) => {
    if (typeof cb === "function") cb(res);
    return res;
  });
}
function http_post(url, headers, body, cb) {
  // legacy quirk preserved from the Dart host: (url, body, headers) form
  if (
    headers &&
    typeof headers === "object" &&
    !body &&
    (headers.body !== undefined || headers.headers)
  ) {
    body = headers.body;
    headers = headers.headers;
  }
  return httpRequest("POST", url, headers, body).then((res) => {
    if (typeof cb === "function") cb(res);
    return res;
  });
}
function http_parallel(requests) {
  return Promise.all(
    (requests || [])
      .slice(0, 10)
      .map((r) =>
        httpRequest(
          (r && r.method) || "GET",
          r && r.url,
          (r && r.headers) || {},
          r && r.body,
        ),
      ),
  );
}

const webcrypto = {
  async decryptAES(data, key, iv, options) {
    const mode = (options && options.mode) || "cbc";
    const keyBuf = Buffer.from(key, "base64");
    const ivBuf = Buffer.from(iv || "", "base64");
    const dataBuf = Buffer.from(data, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-" + keyBuf.length * 8 + "-" + mode,
      keyBuf,
      ivBuf,
    );
    return Buffer.concat([decipher.update(dataBuf), decipher.final()]).toString(
      "utf8",
    );
  },
  async pbkdf2(password, salt, iterations, keyLength) {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        password,
        Buffer.from(salt, "base64"),
        iterations,
        keyLength,
        "sha256",
        (e, k) => (e ? reject(e) : resolve(k.toString("base64"))),
      );
    });
  },
};

// in-memory only: stateless by design (token-caching plugins re-mint per
// instance; acceptable, keeps the bridge hostable on serverless)
const storage = new Map();
function get_storage(req) {
  const v = storage.get(String((req && req.key) || ""));
  return v === undefined ? null : v;
}
function set_storage(req) {
  storage.set(String((req && req.key) || ""), String((req && req.value) ?? ""));
  return true;
}
const prefs = new Map();
function getPreference(key) {
  return prefs.has(key) ? prefs.get(key) : "";
}
function setPreference(key, value) {
  prefs.set(key, value);
  return true;
}

function nativeRegex(text, pattern, group, caseSensitive) {
  try {
    const re = new RegExp(pattern, caseSensitive === false ? "gi" : "g");
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push(m[group] !== undefined ? m[group] : m[0]);
      if (m[0] === "") re.lastIndex++;
    }
    return out;
  } catch (e) {
    return [];
  }
}
function extractPath(cur, parts) {
  for (const part of parts) {
    const idxM = /^(.*)\[(\d+)\]$/.exec(part);
    if (idxM) {
      cur = cur && cur[idxM[1]] ? cur[idxM[1]][+idxM[2]] : undefined;
      continue;
    }
    if (part.endsWith("[*]")) {
      cur = cur && cur[part.slice(0, -3)];
      continue;
    }
    cur = cur ? cur[part] : undefined;
  }
  return cur;
}
function nativeJsonExtract(jsonStr, paths) {
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    return [];
  }
  return (paths || []).map((p) => {
    const v = extractPath(obj, String(p).split("."));
    return v === undefined ? null : v;
  });
}
function nativeMd5(s) {
  return crypto.createHash("md5").update(String(s)).digest("hex");
}
function nativeSha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

class Actor {
  constructor(p) {
    Object.assign(this, p);
  }
}
class Trailer {
  constructor(p) {
    Object.assign(this, p);
  }
}
class NextAiring {
  constructor(p) {
    Object.assign(this, p);
  }
}
class SubtitleFile {
  constructor(p) {
    Object.assign(this, p);
  }
}
class MultimediaItem {
  constructor(params) {
    Object.assign(this, {
      type: "movie",
      status: "ongoing",
      playbackPolicy: "none",
      isAdult: false,
      streams: [],
      syncData: {},
      ...params,
    });
  }
}
class Episode {
  constructor(params) {
    Object.assign(this, {
      season: 0,
      episode: 0,
      dubStatus: "none",
      playbackPolicy: "none",
      streams: [],
      ...params,
    });
  }
}
class StreamResult {
  constructor(p = {}) {
    this.url = p.url;
    this.source = p.source || "Auto";
    this.headers = p.headers;
    this.subtitles = p.subtitles;
    this.drmKid = p.drmKid;
    this.drmKey = p.drmKey;
    this.licenseUrl = p.licenseUrl;
  }
}

function buildContext(code, descriptor) {
  const sandbox = {
    console: {
      log: (...a) => console.log("[plugin]", ...a),
      error: (...a) => console.error("[plugin]", ...a),
      warn: (...a) => console.warn("[plugin]", ...a),
    },
    Buffer,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    manifest: descriptor || {},
    CloudStream: { getLanguage: () => "en", getRegion: () => "US" },
    Actor,
    Trailer,
    NextAiring,
    SubtitleFile,
    MultimediaItem,
    Episode,
    StreamResult,
    http_get,
    http_post,
    http_parallel,
    crypto: webcrypto,
    getAndUnpack: (js) => unpackJs(String(js)),
    parseHtml: (html) => Promise.resolve(parseHtml(html)),
    parse_html: (html, selector, attr) =>
      Promise.resolve(parse_html(html, selector, attr)),
    getPreference,
    setPreference,
    get_storage,
    set_storage,
    nativeRegex,
    nativeJsonExtract,
    nativeMd5,
    nativeSha256,
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { timeout: 10000 });
  return ctx;
}

// call a plugin global that takes a callback (and may also return a promise)
function invoke(ctx, fn, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, value, error) => {
      if (!settled) {
        settled = true;
        resolve({ ok, value, error });
      }
    };
    try {
      const result = fn(...args, (v) =>
        finish(true, v === undefined ? "__dart_void__" : v),
      );
      if (result && typeof result.then === "function") {
        result.then(
          (v) => {
            if (v !== undefined) finish(true, v);
          },
          (e) => finish(false, undefined, String((e && e.message) || e)),
        );
      }
    } catch (e) {
      finish(false, undefined, String((e && e.message) || e));
    }
  });
}

function normalizeResult(value) {
  if (value === undefined || value === null || value === "__dart_void__")
    return { success: true, data: undefined };
  if (typeof value === "object" && !Array.isArray(value)) {
    if (value.success === false)
      return {
        success: false,
        message:
          value.message || value.error || value.errorCode || "plugin error",
      };
    if (value.success === true) return { success: true, data: value.data };
  }
  return { success: true, data: value };
}

function callPlugin(plugin, fn, args) {
  const f = plugin.ctx[fn];
  if (typeof f !== "function")
    return Promise.resolve({
      success: false,
      message: "Function " + fn + " not found",
    });
  return invoke(plugin.ctx, f, args || []).then((r) =>
    r.ok ? normalizeResult(r.value) : { success: false, message: r.error },
  );
}

// ---------- plugin lifecycle ----------

const sourceCache = new Map(); // url -> {code, descriptor, ts}
async function loadSource(url) {
  const cached = sourceCache.get(url);
  if (cached && Date.now() - cached.ts < SOURCE_TTL_MS) return cached;
  const { name, code, descriptor } = await fetchPluginSourceFromSky(url, "");
  const src = { code, descriptor, ts: Date.now() };
  sourceCache.set(url, src);
  return src;
}

const pluginsByKey = new Map(); // slug or b64-key -> plugin
function makePlugin(entry) {
  const p = {
    id: entry.id,
    name: entry.name || entry.id,
    url: entry.url,
    providerId: entry.providerId,
    descriptor: {},
    ctx: null,
    sections: new Map(),
    sectionsTs: 0,
    metaCache: new Map(),
    catalogIndex: new Map(),
    pendingLoads: new Map(),
    warming: null,
    status: "loading",
    error: "",
  };
  pluginsByKey.set(entry.id, p);
  return p;
}

function pluginForKey(key) {
  let p = pluginsByKey.get(key);
  if (p) return p;
  const entry = configById.get(key);
  if (entry) return makePlugin(entry);
  // b64 form: key is base64url of the plugin .sky URL
  try {
    const url = Buffer.from(key, "base64url").toString("utf8");
    if (/^https?:\/\//.test(url)) return makePlugin({ id: key, url });
  } catch (e) {}
  return null;
}

async function ensureRuntime(plugin) {
  if (plugin.ctx) return null;
  try {
    const { code, descriptor } = await loadSource(plugin.url);
    plugin.descriptor = plugin.providerId
      ? { ...descriptor, providerId: plugin.providerId }
      : descriptor;
    plugin.ctx = buildContext(String(code), plugin.descriptor);
    plugin.status = "ok";
    return null;
  } catch (e) {
    plugin.status = "error";
    plugin.error = String((e && e.message) || e);
    return plugin.error;
  }
}

async function warmPlugin(plugin) {
  if (plugin.warming) return plugin.warming;
  await ensureRuntime(plugin);
  if (!plugin.ctx) return null;
  plugin.warming = (async () => {
    if (plugin.sectionsTs && Date.now() - plugin.sectionsTs < CACHE_TTL_MS)
      return;
    const res = await callPlugin(plugin, "getHome", []);
    if (!res.success || !res.data || typeof res.data !== "object") {
      plugin.sectionsTs = Date.now(); // cache the failure so catalogs don't re-call every request
      plugin.status = "error";
      plugin.error = res.message || "getHome failed";
      console.warn(
        "plugin",
        plugin.name,
        "getHome failed:",
        res.message || "no data",
      );
      return;
    }
    const sectionMap = Array.isArray(res.data)
      ? { [plugin.descriptor.name || plugin.name]: res.data }
      : res.data;
    const built = new Map();
    for (const [name, items] of Object.entries(sectionMap)) {
      if (!Array.isArray(items) || !items.length) continue;
      // plugins sometimes sprinkle null/undefined into their lists
      const clean = items.filter((i) => i && typeof i === "object");
      if (!clean.length) continue;
      built.set(slugify(name), {
        name,
        type: mapType(clean[0].type),
        items: clean,
      });
    }
    if (!built.size) {
      // no sections (flaky/blocked upstream) — keep existing, stale beats empty
      plugin.sectionsTs = Date.now();
      plugin.status = "error";
      plugin.error = "getHome returned no sections";
      console.warn("plugin", plugin.name, "getHome returned no sections");
      return;
    }
    // merge, don't replace: plugins drop sections whose page fetch failed at
    // warm time — keep stale sections, fresh ones win
    for (const [slug, section] of plugin.sections) {
      if (!built.has(slug)) built.set(slug, section);
    }
    plugin.sections = built;
    plugin.metaCache.clear();
    plugin.sectionsTs = Date.now();
    plugin.status = "ok";
    plugin.error = "";
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

function cachePut(map, key, ts, value, ttl) {
  map.set(key, { ts, value, ttl });
  if (map.size > 5000) {
    const oldest = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    map.delete(oldest[0]);
  }
}

async function getRawItem(plugin, metaId, timeoutMs) {
  if (!plugin.ctx) return null;
  const cached = plugin.metaCache.get(metaId);
  const ttl = cached && cached.ttl ? cached.ttl : CACHE_TTL_MS;
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  // one in-flight load per id: fast meta and follow-up stream share the call
  let load = plugin.pendingLoads.get(metaId);
  if (!load) {
    load = callPlugin(plugin, "load", [metaId]);
    plugin.pendingLoads.set(metaId, load);
    load
      .then((res) => {
        if (!res || !res.success || !res.data || typeof res.data !== "object")
          return;
        if (!res.data.url) res.data.url = metaId;
        cachePut(plugin.metaCache, metaId, Date.now(), res.data);
      })
      .catch(() => {})
      .finally(() => plugin.pendingLoads.delete(metaId));
  }
  const res = timeoutMs
    ? await Promise.race([
        load,
        new Promise((r) => setTimeout(() => r(META_TIMED_OUT), timeoutMs)),
      ])
    : await load;
  if (res === META_TIMED_OUT) return null; // load still running; no negative cache
  if (!res.success || !res.data || typeof res.data !== "object") {
    // negative cache: a dead id must not re-trigger the full slow load — but
    // keep it short so a transient upstream failure recovers on the next tap
    cachePut(plugin.metaCache, metaId, Date.now(), null, NEGATIVE_TTL_MS);
    return null;
  }
  return res.data;
}

function catalogItemFor(plugin, id) {
  for (const section of plugin.sections.values())
    for (const item of section.items)
      // plugins differ: some emit url, some emit id (movieblast) — match both
      if (item.url === id || item.id === id)
        return {
          ...item,
          url: item.url || item.id || id,
          episodes: [{ name: "Play", url: id }],
        };
  const item = plugin.catalogIndex.get(id);
  if (item)
    return {
      ...item,
      url: item.url || item.id || id,
      episodes: [{ name: "Play", url: id }],
    };
  return null;
}
// ---------- endpoint handlers ----------

function catalogList(plugin) {
  const label = plugin.descriptor.name || plugin.name;
  const prefix = plugin.descriptor.catalogPrefix || label;
  const extras = [
    { name: "skip", options: ["0", "1", "2", "3"] },
    { name: "genre", options: [] },
  ];
  const out = [];
  if (plugin.sections.size === 0) {
    // not warmed yet: advertise the descriptor's declared catalogs so the
    // addon is visible immediately (a slow getHome must not hide it)
    for (const c of plugin.descriptor.catalogs || []) {
      out.push({
        id: c.id || prefix + "_" + (c.name || slugify(c.id || "")),
        type: c.type || "movie",
        name: c.name || c.id,
        extra: extras,
      });
    }
    return out;
  }
  for (const [slug, section] of plugin.sections) {
    out.push({
      id: prefix + "_" + slug,
      type: section.type,
      name: section.name,
      extra: extras,
    });
  }
  return out;
}

function buildManifest(plugin) {
  return {
    id: plugin.id,
    name: plugin.descriptor.name || plugin.name,
    description: plugin.descriptor.description || "",
    logo: plugin.descriptor.iconUrl || "",
    version: "0.1.0",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: catalogList(plugin),
  };
}

function findSection(plugin, catalogId) {
  const prefix =
    plugin.descriptor.catalogPrefix || plugin.descriptor.name || plugin.name;
  if (catalogId.startsWith(prefix + "_")) {
    const slug = catalogId.slice(prefix.length + 1);
    const section = plugin.sections.get(slug);
    if (section) return { section, slug };
  }
  for (const [slug, section] of plugin.sections)
    if (slug === catalogId) return { section, slug };
  return null;
}

async function handleCatalog(req, res, plugin, type, catalogId, base) {
  const q = new URLSearchParams((req.url || "").split("?")[1] || "");
  const search = (q.get("search") || "").trim();
  const skip = Math.max(0, Number(q.get("skip")) || 0);
  const genre = (q.get("genre") || "").trim();
  let items = [];
  let found = null;
  if (search) {
    // global search hits /catalog/<type>/<id>.json?search=... — route to the
    // plugin's search and merge
    const fn =
      typeof plugin.ctx.search === "function"
        ? "search"
        : typeof plugin.ctx.getSearch === "function"
          ? "getSearch"
          : null;
    if (fn) {
      const r = await callPlugin(plugin, fn, [search]);
      if (r.success && Array.isArray(r.data)) {
        const seen = new Set();
        for (const item of r.data) {
          if (!item || !item.url || mapType(item.type) !== type) continue;
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          items.push(item);
        }
      }
    }
  } else {
    found = findSection(plugin, catalogId);
    if (!found)
      return sendJson(res, 404, { error: "unknown catalog: " + catalogId });
    if (Date.now() - plugin.sectionsTs > CACHE_TTL_MS) await warmPlugin(plugin);
    found = findSection(plugin, catalogId); // re-lookup after warm
    if (!found) return sendJson(res, 200, { metas: [] });
    items = found.section.items;
    if (genre) {
      const g = genre.toLowerCase();
      items = items.filter((it) =>
        (it.tags || []).some((t) => String(t).toLowerCase().includes(g)),
      );
    }
    if (skip > 0) items = items.slice(skip, skip + 20);
  }
  for (const it of items) plugin.catalogIndex.set(it.url || it.id, it);
  if (plugin.catalogIndex.size > 20000) plugin.catalogIndex.clear();
  sendJson(res, 200, {
    metas: items
      .map((it) => mapItem(it, found && found.slug))
      .filter((m) => m.id),
  });
}

async function handleMeta(req, res, plugin, type, id) {
  let item = await getRawItem(plugin, id, META_FAST_MS);
  if (!item) {
    // Nuvio caps meta at 5s — never wait for the slow upstream load. Serve
    // the catalog fallback (name/poster from the last catalog the client
    // browsed); the background load keeps running, so the follow-up stream
    // request gets the real data.
    item = catalogItemFor(plugin, id);
    if (!item) {
      const last = id.split("/").filter(Boolean).pop();
      item = {
        id,
        url: id,
        type,
        name: last || id,
        episodes: [{ name: "Play", url: id }],
      };
    }
  }
  sendJson(res, 200, { meta: mapMeta(item) });
}

async function loadStreamsFor(plugin, id) {
  const r = await callPlugin(plugin, "loadStreams", [id]);
  return r.success && Array.isArray(r.data) ? r.data : [];
}

async function handleStream(req, res, plugin, type, id, base) {
  let raw = [];
  // SkyStream convention: series video ids are <metaId>:<season>:<episode>
  const m = /^(.*):(\d+):(\d+)$/.exec(id);
  if (m) {
    const metaId = m[1];
    const season = +m[2];
    const episode = +m[3];
    const item = await getRawItem(plugin, metaId);
    if (item && Array.isArray(item.episodes)) {
      const idx = item.episodes.findIndex((e, i) => {
        const n = epNumbers(e, i);
        return n.season === season && n.episode === episode;
      });
      if (idx >= 0)
        raw = await loadStreamsFor(plugin, item.episodes[idx].url || metaId);
    }
  }
  if (!raw.length) {
    const item = await getRawItem(plugin, id);
    if (item && Array.isArray(item.streams) && item.streams.length)
      raw = item.streams;
    else if (item && Array.isArray(item.episodes) && item.episodes.length)
      raw = await loadStreamsFor(plugin, item.episodes[0].url || id);
    else raw = await loadStreamsFor(plugin, id);
  }
  sendJson(res, 200, {
    streams: raw
      .filter((s) => s && s.url)
      .map((s) => mapStream(s, base, plugin.name)),
  });
}

// ---------- proxy (m3u8 rewrite + byte streaming with Range) ----------

async function fetchSafe(url, headers, maxHops, signal) {
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

async function handleProxy(req, res, plugin, payloadPath) {
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
      "X-Content-Type-Options": "nosniff",
    });
    return res.end(rewritten);
  }

  let url = "";
  let extraHeaders = {};
  try {
    const obj = JSON.parse(decoded);
    if (obj && typeof obj.url === "string") {
      url = obj.url;
      extraHeaders =
        obj.headers && typeof obj.headers === "object" ? obj.headers : {};
    }
  } catch (e) {
    url = decoded;
  }
  if (!url || typeof url !== "string" || !/^https?:\/\//.test(url))
    return sendJson(res, 400, { error: "bad proxy url" });
  if (!extraHeaders["Referer"]) {
    try {
      extraHeaders["Referer"] = new URL(url).origin + "/";
    } catch (e) {}
  }
  const headers = { ...extraHeaders };
  if (!headers["User-Agent"] && !headers["user-agent"])
    headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  if (!headers["Accept-Encoding"] && !headers["accept-encoding"])
    headers["Accept-Encoding"] = "identity";
  if (req.headers.range) headers["Range"] = req.headers.range;
  const isHead = req.method === "HEAD";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const upstream = await fetchSafe(
      url,
      { ...headers, method: isHead ? "HEAD" : "GET" },
      5,
      ctrl.signal,
    );
    const outHeaders = {
      "Content-Type":
        upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    };
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
    stream.on("error", () => res.end());
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

// ---------- router ----------

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

function serveStatic(res, entry) {
  const file = path.join(__dirname, "public", entry.file);
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": entry.type,
      "Content-Length": data.length,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end();
  }
  const urlPath = (req.url || "/").split("?")[0];
  const base = publicBase(req);

  if (STATIC_FILES[urlPath]) return serveStatic(res, STATIC_FILES[urlPath]);
  if (urlPath === "/api/plugins")
    return sendJson(res, 200, {
      plugins: CONFIG.map((e) => ({
        id: e.id,
        name: e.name || e.id,
        addonUrl: base + "/" + e.id + "/manifest.json",
      })),
    });

  // list plugins under any github URL (single file or whole repo) — live,
  // nothing stored
  if (urlPath === "/api/plugins-from-url") {
    const q = new URL(req.url, "http://x").searchParams;
    const u = q.get("url") || "";
    if (!u) return sendJson(res, 400, { error: "missing ?url=" });
    try {
      return sendJson(res, 200, {
        url: u,
        plugins: await listPluginsInGithub(u),
      });
    } catch (e) {
      return sendJson(res, 400, { error: String((e && e.message) || e) });
    }
  }

  // /plugin/<b64url>/... — plugin identified by its .sky URL in the path
  const b64M = /^\/plugin\/([A-Za-z0-9_-]+)(\/.*)$/.exec(urlPath);
  // /<slug>/... — plugin from the config
  const slugM = /^\/([^/]+)(\/.*)$/.exec(urlPath);
  const key = b64M ? b64M[1] : slugM ? slugM[1] : null;
  const rest = b64M ? b64M[2] : slugM ? slugM[2] : "";
  if (!key || !rest) return sendJson(res, 404, { error: "not found" });

  const plugin = pluginForKey(key);
  if (!plugin) return sendJson(res, 404, { error: "unknown plugin: " + key });
  const runtimeError = await ensureRuntime(plugin);
  if (runtimeError)
    return sendJson(res, 502, {
      error: "plugin failed to load: " + runtimeError,
    });

  if (rest === "/manifest.json") {
    // first manifest fetch warms the catalogs (slow getHome must not block
    // the addon being visible — descriptor catalogs are advertised meanwhile)
    const warmed = warmPlugin(plugin).catch(() => {});
    if (plugin.sections.size === 0 && plugin.descriptor.catalogs?.length)
      return sendJson(res, 200, buildManifest(plugin));
    await warmed;
    return sendJson(res, 200, buildManifest(plugin));
  }

  const metaM = /^\/meta\/(movie|series)\/(.+)\.json$/.exec(rest);
  if (metaM) return handleMeta(req, res, plugin, metaM[1], decodeId(metaM[2]));

  const streamM = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(rest);
  if (streamM)
    return handleStream(
      req,
      res,
      plugin,
      streamM[1],
      decodeId(streamM[2]),
      base,
    );

  const catalogM = /^\/catalog\/(movie|series)\/(.+)\.json$/.exec(rest);
  if (catalogM)
    return handleCatalog(
      req,
      res,
      plugin,
      catalogM[1],
      decodeId(catalogM[2]),
      base,
    );

  const proxyM = /^\/proxy\/(.+)$/.exec(rest);
  if (proxyM) return handleProxy(req, res, plugin, proxyM[1]);

  return sendJson(res, 404, { error: "not found" });
}

// ---------- boot ----------

function handler(req, res) {
  handleRequest(req, res).catch((e) => {
    if (!res.headersSent)
      sendJson(res, 500, {
        error: "internal error: " + String((e && e.message) || e),
      });
    else res.end();
  });
}

if (require.main === module) {
  const server = http.createServer(handler);
  server.on("error", (e) => {
    console.error("server error:", e);
    if (e.code === "EADDRINUSE") process.exit(1);
  });
  server.listen(PORT, () => {
    console.log("plugin bridge listening on :" + PORT);
    console.log(
      "configured plugins:",
      CONFIG.map((e) => e.id).join(", ") || "(none)",
    );
  });
}

module.exports = { handler };
