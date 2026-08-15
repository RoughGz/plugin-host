const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;
const { Readable } = require("node:stream");
const { PluginRuntime, callPlugin } = require("./lib/plugin-host");
const {
  installPlugin,
  normalizePluginUrl,
  pluginNameFromUrl,
  appendToPluginsTxt,
  dropFromPluginsTxt,
} = require("./lib/plugin-url");

const ROOT = __dirname;
const PLUGINS_DIR = path.join(ROOT, "plugins");
const PLUGINS_FILE = path.join(ROOT, "plugins.txt"); // one plugin URL per line; order = catalog order
const PORT = process.env.PORT || 3999;
const CACHE_TTL_MS = 10 * 60 * 1000;
const META_CACHE_MAX = 200;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
} catch (e) {
  console.error("config.json missing/invalid:", e.message);
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || config.adminToken || null;

const plugins = new Map(); // name -> { name, dir, descriptor, runtime, sections, sectionsTs, metaCache }

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

const pluginOrder = []; // plugins.txt order = catalog order (file plugins first, web/CLI adds after)

async function installFromUrlsFile() {
  if (!fs.existsSync(PLUGINS_FILE)) return;
  let lines;
  try {
    lines = fs.readFileSync(PLUGINS_FILE, "utf8").split("\n");
  } catch (e) {
    console.warn("plugins.txt unreadable:", e.message);
    return;
  }
  for (const rawLine of lines) {
    const url = rawLine.trim().replace(/#.*$/, "").trim();
    if (!url) continue;
    const name = pluginNameFromUrl(url);
    if (!name) {
      console.warn("plugins.txt: skipping unrecognized URL:", url);
      continue;
    }
    if (!pluginOrder.includes(name)) pluginOrder.push(name);
    if (fs.existsSync(path.join(PLUGINS_DIR, name, "plugin.js"))) continue;
    try {
      await installPlugin(url, PLUGINS_DIR);
      console.log("installed plugin from plugins.txt:", name);
    } catch (e) {
      console.warn("plugins.txt:", name, "failed:", e.message);
    }
  }
}

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
      // plugin.json optional
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
    console.log("loaded plugin:", entry.name);
  }
  if (!found) console.warn("no plugins found in", PLUGINS_DIR);
  // file plugins keep plugins.txt order; web/CLI adds go after (catalog order = file order)
  const ordered = [];
  for (const name of pluginOrder) {
    const p = plugins.get(name);
    if (p) ordered.push(p);
  }
  for (const [name, p] of plugins)
    if (!pluginOrder.includes(name)) ordered.push(p);
  plugins.clear();
  for (const p of ordered) plugins.set(p.name, p);
  return [...plugins.values()];
}

async function warmPlugin(plugin, force) {
  if (plugin.warming) return plugin.warming;
  plugin.warming = (async () => {
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
      plugin.sectionsTs = Date.now(); // cache the failure so catalogs don't re-call on every request
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
  })().finally(() => {
    plugin.warming = null;
  });
  return plugin.warming;
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
        } catch (e) {}
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
  if (plugin.metaCache.size >= META_CACHE_MAX) {
    let oldestKey = null,
      oldestTs = Infinity;
    for (const [k, v] of plugin.metaCache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) plugin.metaCache.delete(oldestKey);
  }
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

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function homePage() {
  const items = [];
  for (const [name, p] of plugins) {
    items.push(
      "<li><code>" +
        esc(name) +
        "</code> <span style='color:#666'>(" +
        esc(p.descriptor.name || "no plugin.json") +
        ")</span> <button onclick='removePlugin(\"" +
        esc(name) +
        "\")'>remove</button></li>",
    );
  }
  const title = esc(config.name || "Plugin Host");
  return (
    "<!doctype html><html><head><meta charset='utf-8'><title>" +
    title +
    "</title></head><body style='font-family:system-ui;max-width:640px;margin:40px auto'>" +
    "<h2>" +
    title +
    " — add a plugin</h2>" +
    "<p style='color:#666'>Paste a GitHub tree/blob folder URL or a raw plugin.js URL, then press Add. The plugin is installed and live immediately.</p>" +
    "<form id='f' style='display:flex;gap:8px'>" +
    "<input id='u' style='flex:1;padding:8px' placeholder='https://github.com/user/repo/tree/main/plugin-folder'>" +
    "<button style='padding:8px 16px'>Add plugin</button></form>" +
    "<p id='msg'></p><h3>Installed</h3><ul id='list'>" +
    (items.length ? items.join("") : "<li style='color:#666'>none yet</li>") +
    "</ul>" +
    "<p style='color:#999;font-size:12px'>Stremio: open /manifest.json in Stremio → Addon → Custom URL.</p>" +
    "<script>" +
    "const f=document.getElementById('f'),u=document.getElementById('u'),m=document.getElementById('msg');" +
    "f.onsubmit=async e=>{e.preventDefault();m.textContent='installing...';" +
    "const r=await fetch('/add-plugin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u.value})});" +
    "const j=await r.json();m.textContent=j.error?'FAILED: '+j.error:'ok — '+j.name+' is live';if(!j.error)setTimeout(()=>location.reload(),800)};" +
    "async function removePlugin(n){await fetch('/remove-plugin/'+n,{method:'DELETE'});location.reload()}" +
    "</script></body></html>"
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      body += c;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        done = true;
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!done) resolve(body);
    });
    req.on("error", reject);
  });
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN) return true; // no token configured → open (single-tenant/trusted)
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : req.headers["x-admin-token"] || "";
  return token === ADMIN_TOKEN;
}

async function handleAddPlugin(req, res) {
  if (!requireAdmin(req))
    return sendJson(res, 401, { error: "unauthorized (set ADMIN_TOKEN)" });
  try {
    const body = await readBody(req);
    const raw =
      (JSON.parse(body).url || "").trim() ||
      new URLSearchParams(body).get("url") ||
      "";
    if (!raw) return sendJson(res, 400, { error: "missing url" });
    const url = normalizePluginUrl(raw);
    const { name } = await installPlugin(url, PLUGINS_DIR);
    // keep plugins.txt in sync so the plugin survives a redeploy; the file
    // watcher (debounced 500ms) reloads and re-warms once
    appendToPluginsTxt(PLUGINS_FILE, url);
    sendJson(res, 200, { ok: true, name, url });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

function handleRemovePlugin(req, res, name) {
  if (!requireAdmin(req))
    return sendJson(res, 401, { error: "unauthorized (set ADMIN_TOKEN)" });
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.startsWith("__"))
    return sendJson(res, 400, { error: "invalid plugin name" });
  const dir = path.join(PLUGINS_DIR, name);
  if (!fs.existsSync(path.join(dir, "plugin.js")))
    return sendJson(res, 404, { error: "no plugin named " + name });
  fs.rmSync(dir, { recursive: true, force: true });
  // without dropping the plugins.txt line the file-based reload reinstalls it
  dropFromPluginsTxt(PLUGINS_FILE, name);
  sendJson(res, 200, { ok: true, removed: name });
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

function isPrivateIp(ip) {
  if (ip === "0.0.0.0" || ip === "::" || ip === "::1") return true;
  if (/^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip))
    return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true; // link-local incl. cloud metadata
  if (/^fe80:/i.test(ip) || /^f[cd]/i.test(ip)) return true;
  return false;
}

async function isPrivateHost(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".local")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":"))
    return isPrivateIp(hostname);
  try {
    const { address } = await dns.lookup(hostname);
    return isPrivateIp(address);
  } catch (e) {
    return true; // unresolvable → refuse
  }
}

// fetch with per-hop SSRF check and no silent cross-host redirects
async function fetchSafe(url, headers, maxHops) {
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
    const res = await fetch(cur, { headers, redirect: "manual" });
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
  try {
    const upstream = await fetchSafe(url, {
      ...headers,
      method: isHead ? "HEAD" : "GET",
    });
    const outHeaders = {
      "Content-Type":
        upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
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
    // rewrite magic-wrapped segment URIs to this proxy
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
      // invalid url; fetchSafe reports it
    }
  }
  await proxyFetch(url, extraHeaders, req, res);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const query = new URLSearchParams(req.url.split("?")[1] || "");
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(homePage());
    }
    if (url === "/add-plugin" && req.method === "POST") {
      return handleAddPlugin(req, res);
    }
    const removeM = /^\/remove-plugin\/([^/]+)$/.exec(url);
    if (removeM && req.method === "DELETE") {
      return handleRemovePlugin(req, res, removeM[1]);
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

// hot reload: any change under plugins/ or plugins.txt → reload + re-warm.
// Serialized; events during boot are ignored (boot loads everything itself).
let booting = true;
let reloadTimer = null;
let reloadChain = Promise.resolve();
const reloadNow = () => {
  if (booting) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadChain = reloadChain
      .then(async () => {
        console.log("plugins changed — reloading");
        await installFromUrlsFile();
        loadPlugins();
        await warmAll(true);
      })
      .catch((e) => console.warn("reload failed:", e.message));
  }, 500);
};
fs.watch(PLUGINS_DIR, { recursive: true }, () => reloadNow());
try {
  fs.watch(PLUGINS_FILE, () => reloadNow());
} catch (e) {
  // plugins.txt optional
}

async function boot() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true }); // repo may ship without the dir (git ignores empty folders)
  await installFromUrlsFile();
  loadPlugins();
  await warmAll(true);
  booting = false;
  server.listen(PORT, () =>
    console.log("addon listening on http://localhost:" + PORT),
  );
}

// refresh catalogs periodically so the manifest stays current
setInterval(() => warmAll(true).catch(() => {}), 30 * 60 * 1000).unref();

function shutdown() {
  console.log("shutting down");
  server.close();
  for (const p of plugins.values()) p.runtime.destroy();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.on("error", (e) => {
  console.error("server error:", e);
  if (e.code === "EADDRINUSE") process.exit(1);
});

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});
