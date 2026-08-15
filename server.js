// Stremio addon engine — Skystream plugin host. Zero-dependency Node.js server.
// Every folder under plugins/ (plugin.js + optional plugin.json) is a source:
// getHome sections → catalogs, load → meta, loadStreams → streams.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { PluginRuntime, callPlugin } = require("./lib/plugin-host");

const ROOT = __dirname;
const PLUGINS_DIR = path.join(ROOT, "plugins");
const PORT = process.env.PORT || 3999;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
} catch (e) {
  console.error("config.json missing/invalid:", e.message);
}

// ---------- plugin registry ----------

const plugins = new Map(); // name -> { name, dir, descriptor, runtime, sections: Map<slug,{name,type,items}>, sectionsTs, metaCache: Map<id,{ts,item}> }

function publicBase(req) {
  return (
    (process.env.PUBLIC_URL || config.publicUrl || "").replace(/\/$/, "") ||
    "https://" + (req.headers.host || "localhost:" + PORT)
  );
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "home"
  );
}

const TYPE_MAP = {
  movie: "movie",
  series: "series",
  tvseries: "series",
  anime: "series",
  livestream: "series",
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
function itemPoster(item) {
  return item.posterUrl || item.logoUrl || undefined;
}

function mapItem(item) {
  return {
    id: item.url,
    type: mapType(item.type),
    name: itemName(item),
    poster: itemPoster(item),
    background: item.bannerUrl || item.backgroundPosterUrl,
    description: item.description,
    releaseInfo: item.year ? String(item.year) : undefined,
    imdbRating: item.score != null ? String(item.score) : undefined,
  };
}

function mapCast(item) {
  const cast = item.cast || item.actors || [];
  return cast
    .map((c) => ({
      name: c.name || c.actor,
      role: c.role || c.roleString,
      image: c.image,
    }))
    .filter((c) => c.name);
}

function mapMeta(item) {
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  const videos = episodes.map((ep, i) => ({
    id:
      ep.season != null && ep.episode != null && (ep.season || ep.episode)
        ? "e" + (ep.season || 0) + "x" + (ep.episode || 0)
        : "e" + i,
    title: ep.name || "Episode " + (ep.episode || i + 1),
    season: ep.season || 1,
    episode: ep.episode || i + 1,
    released: ep.airDate,
    thumbnail: ep.posterUrl,
    overview: ep.description,
  }));
  if (!videos.length && Array.isArray(item.streams) && item.streams.length)
    videos.push({ id: "direct", title: "Play" });
  return {
    id: item.url,
    type: mapType(item.type),
    name: itemName(item),
    poster: itemPoster(item),
    background: item.bannerUrl || item.backgroundPosterUrl,
    logo: item.logoUrl,
    description: item.description,
    releaseInfo: item.year ? String(item.year) : undefined,
    imdbRating: item.score != null ? String(item.score) : undefined,
    genres: item.tags || [],
    cast: mapCast(item),
    videos,
  };
}

function transformStreamUrl(url, base) {
  if (typeof url !== "string") return url;
  if (url.startsWith("MAGIC_PROXY_v2") || url.startsWith("MAGIC_PROXY_v1"))
    return base + "/proxy/" + Buffer.from(url.slice(15)).toString("base64url");
  if (url.startsWith("MAGIC_PROXY:"))
    return base + "/proxy/" + Buffer.from(url.slice(11)).toString("base64url");
  if (url.startsWith("magic_m3u8:"))
    return base + "/proxy/" + Buffer.from(url.slice(11)).toString("base64url");
  return url;
}

function mapStream(s, base) {
  const q = typeof s.quality === "number" ? QUALITY_MAP[s.quality] : s.quality;
  const title = [s.source && s.source !== "Auto" ? s.source : "", q]
    .filter(Boolean)
    .join(" ")
    .trim();
  const out = { url: transformStreamUrl(s.url, base) };
  if (title) out.title = title;
  out.behaviorHints = { notWebReady: false };
  if (Array.isArray(s.subtitles) && s.subtitles.length) {
    out.subtitles = s.subtitles.map((sub) => ({
      lang: sub.lang || sub.label || "en",
      url: sub.url,
    }));
  }
  return out;
}

// ---------- plugin lifecycle ----------

function loadPlugins() {
  for (const p of plugins.values()) p.runtime.destroy();
  plugins.clear();
  let found = false;
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PLUGINS_DIR, entry.name);
    const jsPath = path.join(dir, "plugin.js");
    if (!fs.existsSync(jsPath)) continue;
    found = true;
    let descriptor = {};
    const jsonPath = path.join(dir, "plugin.json");
    try {
      descriptor = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (e) {
      /* plugin.json optional */
    }
    const code = fs.readFileSync(jsPath, "utf8");
    const plugin = {
      name: entry.name,
      dir,
      descriptor,
      sections: new Map(),
      sectionsTs: 0,
      metaCache: new Map(),
      runtime: new PluginRuntime(entry.name, code, descriptor, {
        verifyUA: descriptor.verifyUA || null,
      }),
    };
    plugins.set(entry.name, plugin);
    console.log(
      "loaded plugin:",
      entry.name,
      "| api:",
      plugin.runtime.api.join(", "),
    );
  }
  if (!found) console.warn("no plugins found in", PLUGINS_DIR);
  return [...plugins.values()];
}

async function warmPlugin(plugin, force) {
  if (
    !force &&
    plugin.sectionsTs &&
    Date.now() - plugin.sectionsTs < CACHE_TTL_MS
  )
    return;
  plugin.sections.clear();
  plugin.metaCache.clear();
  const res = await callPlugin(plugin.runtime, "getHome", []);
  if (!res.success || !res.data || typeof res.data !== "object") {
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
  for (const [name, items] of Object.entries(sectionMap)) {
    if (!Array.isArray(items) || !items.length) continue;
    const firstType = mapType(items[0].type);
    plugin.sections.set(slugify(name), { name, type: firstType, items });
  }
  plugin.sectionsTs = Date.now();
  rebuildPrefixMap();
  console.log(
    "plugin",
    plugin.name,
    "catalogs:",
    [...plugin.sections.keys()].join(", ") || "(none)",
  );
}

async function warmAll(force) {
  await Promise.all(
    [...plugins.values()].map((p) =>
      warmPlugin(p, force).catch((e) =>
        console.warn("warm", p.name, "failed:", e.message),
      ),
    ),
  );
  return catalogList();
}

function rebuildPrefixMap() {
  prefixMap.clear();
  for (const p of plugins.values()) {
    if (p.descriptor.idPrefix)
      prefixMap.set(String(p.descriptor.idPrefix).replace(/\/$/, ""), p.name);
    for (const { items } of p.sections.values()) {
      for (const item of items) {
        if (!item.url || typeof item.url !== "string") continue;
        try {
          const origin = new URL(item.url).origin;
          prefixMap.set(origin, p.name);
        } catch (e) {
          /* non-URL ids ignored */
        }
      }
    }
  }
}

const prefixMap = new Map();

function pluginForId(id) {
  if (!id || typeof id !== "string") return null;
  let best = null;
  for (const [prefix, name] of prefixMap) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length))
      best = { prefix, name };
  }
  if (best) return plugins.get(best.name);
  if (plugins.size === 1) return [...plugins.values()][0];
  return null;
}

function catalogList() {
  const multi = plugins.size > 1;
  const out = [];
  for (const p of plugins.values()) {
    const label = p.descriptor.name || p.name;
    const prefix = p.descriptor.catalogPrefix || p.name;
    for (const [slug, section] of p.sections) {
      out.push({
        id: prefix + "_" + slug,
        type: section.type,
        name: multi ? label + " • " + section.name : section.name,
      });
    }
  }
  return out;
}

function findCatalog(catalogId) {
  for (const p of plugins.values()) {
    const prefix = p.descriptor.catalogPrefix || p.name;
    if (catalogId.startsWith(prefix + "_")) {
      const section = p.sections.get(catalogId.slice(prefix.length + 1));
      if (section) return { plugin: p, section };
    }
  }
  return null;
}

async function getRawItem(plugin, metaId) {
  const cached = plugin.metaCache.get(metaId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.item;
  const res = await callPlugin(plugin.runtime, "load", [metaId]);
  if (!res.success || !res.data || typeof res.data !== "object") return null;
  plugin.metaCache.set(metaId, { ts: Date.now(), item: res.data });
  return res.data;
}

// ---------- handlers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function handleCatalog(req, res, type, catalogId, search) {
  const found = findCatalog(catalogId);
  if (!found)
    return sendJson(res, 404, { error: "unknown catalog: " + catalogId });
  let items;
  if (search) {
    const r = await callPlugin(found.plugin.runtime, "search", [search]);
    items = r.success && Array.isArray(r.data) ? r.data : [];
  } else {
    if (Date.now() - found.plugin.sectionsTs > CACHE_TTL_MS)
      await warmPlugin(found.plugin);
    items = found.section.items;
  }
  sendJson(res, 200, { metas: items.map(mapItem).filter((m) => m.id) });
}

async function handleMeta(req, res, type, id) {
  const plugin = pluginForId(id);
  if (!plugin) return sendJson(res, 404, { error: "no plugin for id: " + id });
  const item = await getRawItem(plugin, id);
  if (!item) return sendJson(res, 404, { error: "meta not found" });
  sendJson(res, 200, { meta: mapMeta(item) });
}

async function handleStream(req, res, type, id) {
  const m = /^(.*):(\d+):(\d+)$/.exec(id);
  const metaId = m ? m[1] : id;
  const season = m ? +m[2] : null;
  const episode = m ? +m[3] : null;
  const plugin = pluginForId(metaId);
  if (!plugin) return sendJson(res, 404, { error: "no plugin for id: " + id });
  const base = publicBase(req);

  let raw = [];
  if (season !== null) {
    const item = await getRawItem(plugin, metaId);
    if (item && Array.isArray(item.episodes)) {
      const ep = item.episodes.find(
        (e) => e.season === season && e.episode === episode,
      );
      if (ep) {
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
  if (!raw.length) return sendJson(res, 404, { error: "no streams found" });
  sendJson(res, 200, {
    streams: raw.filter((s) => s && s.url).map((s) => mapStream(s, base)),
  });
}

// ---------- magic-URL proxy ----------

async function proxyFetch(url, extraHeaders, req, res) {
  const headers = { ...extraHeaders };
  if (!headers["User-Agent"] && !headers["user-agent"])
    headers["User-Agent"] = DEFAULT_UA;
  if (!headers["Accept-Encoding"] && !headers["accept-encoding"])
    headers["Accept-Encoding"] = "identity";
  if (req.headers.range) headers["Range"] = req.headers.range;
  try {
    const upstream = await fetch(url, { headers, redirect: "follow" });
    const outHeaders = {
      "Content-Type":
        upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    if (upstream.headers.get("content-length"))
      outHeaders["Content-Length"] = upstream.headers.get("content-length");
    if (upstream.headers.get("content-range"))
      outHeaders["Content-Range"] = upstream.headers.get("content-range");
    if (upstream.headers.get("accept-ranges"))
      outHeaders["Accept-Ranges"] = upstream.headers.get("accept-ranges");
    res.writeHead(upstream.status, outHeaders);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    if (!res.headersSent)
      sendJson(res, 502, { error: "proxy fetch failed: " + e.message });
    else res.end();
  }
}

async function handleProxy(req, res) {
  const payload = decodeURIComponent(req.url.split("/").slice(2).join("/"));
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
    // m3u8 playlist: rewrite magic-wrapped segment URIs to this proxy
    const rewritten = decoded
      .split("\n")
      .map((line) => {
        if (
          line.startsWith("MAGIC_PROXY_v2") ||
          line.startsWith("MAGIC_PROXY_v1")
        )
          return (
            base + "/proxy/" + Buffer.from(line.slice(15)).toString("base64url")
          );
        if (line.startsWith("MAGIC_PROXY:"))
          return (
            base + "/proxy/" + Buffer.from(line.slice(11)).toString("base64url")
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
      /* ignore */
    }
  }
  await proxyFetch(url, extraHeaders, req, res);
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const query = new URLSearchParams(req.url.split("?")[1] || "");
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }
    if (url === "/manifest.json") {
      return sendJson(res, 200, {
        id: config.id || "com.stremio.addon",
        name: config.name || "Stremio Addon",
        description: config.description || "",
        logo: config.logo || "",
        version: "0.1.0",
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        catalogs: catalogList(),
      });
    }
    const proxyM = /^\/proxy\/(.+)$/.exec(url);
    if (proxyM) return handleProxy(req, res);
    const catM = /^\/catalog\/(movie|series)\/([^/]+)\.json$/.exec(url);
    if (catM)
      return handleCatalog(
        req,
        res,
        catM[1],
        decodeURIComponent(catM[2]),
        query.get("search"),
      );
    const metaM = /^\/meta\/(movie|series)\/([^/]+)\.json$/.exec(url);
    if (metaM)
      return handleMeta(req, res, metaM[1], decodeURIComponent(metaM[2]));
    const streamM = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(url);
    if (streamM)
      return handleStream(req, res, streamM[1], decodeURIComponent(streamM[2]));
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("request error:", e);
    sendJson(res, 500, { error: e.message || "internal error" });
  }
});

async function boot() {
  loadPlugins();
  await warmAll(true);
  server.listen(PORT, () =>
    console.log("addon listening on http://localhost:" + PORT),
  );
}

// hot reload: any change under plugins/ → reload + re-warm
let reloadTimer = null;
fs.watch(PLUGINS_DIR, { recursive: true }, (event, filename) => {
  console.log("watch event:", event, filename);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    console.log("plugins changed — reloading");
    loadPlugins();
    await warmAll(true);
  }, 500);
});

// refresh catalogs periodically so manifest stays current
setInterval(() => warmAll(true).catch(() => {}), 30 * 60 * 1000).unref();

boot();
