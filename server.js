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
fs.mkdirSync(PLUGINS_DIR, { recursive: true }); // git ignores empty dirs; fs.watch below needs it to exist
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
let urlVersion = 1; // bumps on add/remove so the install URL is fresh per change

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
      streamCache: new Map(),
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

function cachePut(map, key, ts, value) {
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
  map.set(key, { ts, value });
}

async function getRawItem(plugin, metaId) {
  const cached = plugin.metaCache.get(metaId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  const res = await callPlugin(plugin.runtime, "load", [metaId]);
  if (!res.success || !res.data || typeof res.data !== "object") return null;
  cachePut(plugin.metaCache, metaId, Date.now(), res.data);
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

function homePage(req) {
  const base = publicBase(req);
  // ?v= bumps on every add/remove so the install URL is fresh per change
  const manifestUrl = base + "/manifest.json?v=" + urlVersion;
  const installHref =
    "stremio://" +
    base.replace(/^https?:\/\//, "") +
    "/manifest.json?v=" +
    urlVersion;
  const title = esc(config.name || "Plugin Host");
  const desc = esc(config.description || "");
  const items = [];
  for (const [name, p] of plugins) {
    const cats = p.sections.size;
    items.push(
      "<li class='plug'><div class='plug-info'><strong>" +
        esc(name) +
        "</strong><span class='sub'>" +
        esc(p.descriptor.name || "no plugin.json") +
        (cats ? " · " + cats + " catalog" + (cats > 1 ? "s" : "") : "") +
        "</span></div><button class='rm' onclick='removePlugin(\"" +
        esc(name) +
        "\")'>remove</button></li>",
    );
  }
  return (
    "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" +
    title +
    "</title><style>" +
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1117;color:#e6e8ee}" +
    ".wrap{max-width:720px;margin:0 auto;padding:32px 20px 64px}" +
    "header{margin-bottom:28px}h1{margin:0 0 6px;font-size:26px}h1 span{color:#7c5cff}" +
    ".sub{color:#9aa0ae;font-size:14px;line-height:1.5}" +
    ".card{background:#171a23;border:1px solid #262a36;border-radius:12px;padding:20px;margin-bottom:16px}" +
    "h2{margin:0 0 12px;font-size:16px;color:#cdd2de}" +
    ".urlbox{display:flex;gap:8px;margin-bottom:12px}" +
    ".urlbox input{flex:1;min-width:0;background:#0f1117;border:1px solid #2c3140;color:#9fe6a0;font-family:ui-monospace,monospace;font-size:13px;border-radius:8px;padding:10px}" +
    "button{cursor:pointer;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600}" +
    ".btn{background:#7c5cff;color:#fff}.btn:hover{background:#8d71ff}" +
    ".btn-ghost{background:#232838;color:#e6e8ee;border:1px solid #2c3140}.btn-ghost:hover{background:#2b3142}" +
    ".btns{display:flex;gap:8px;flex-wrap:wrap}" +
    "a.install{text-decoration:none;display:inline-block;text-align:center}" +
    "form{display:flex;gap:8px;flex-wrap:wrap}form input[type=text]{flex:1;min-width:200px;background:#0f1117;border:1px solid #2c3140;color:#e6e8ee;border-radius:8px;padding:10px;font-size:13px}" +
    "form input[type=password]{width:110px;background:#0f1117;border:1px solid #2c3140;color:#e6e8ee;border-radius:8px;padding:10px;font-size:13px}" +
    "#msg{margin:10px 0 0;font-size:13px;min-height:18px}.ok{color:#7ed47e}.err{color:#ff7b7b}" +
    "ul{list-style:none;margin:0;padding:0}.plug{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#14161e;border:1px solid #232836;border-radius:8px;padding:12px 14px;margin-bottom:8px}" +
    ".plug-info{display:flex;flex-direction:column;gap:2px;min-width:0;word-break:break-all}" +
    ".plug .sub{font-size:12px}" +
    ".rm{background:#3a1f26;color:#ff9a9a;padding:6px 12px;font-size:12px;border:1px solid #542b34}.rm:hover{background:#4a2630}" +
    "footer{color:#6b7180;font-size:12px;margin-top:24px;line-height:1.6}" +
    "code{background:#232838;padding:1px 5px;border-radius:4px;font-size:12px}" +
    "</style></head><body><div class='wrap'>" +
    "<header><h1><span>▶</span> " +
    title +
    "</h1>" +
    (desc ? "<div class='sub'>" + desc + "</div>" : "") +
    "</header>" +
    "<div class='card'><h2>Your addon URL</h2>" +
    "<div class='urlbox'><input id='url' readonly value='" +
    manifestUrl +
    "' onclick='this.select()'></div>" +
    "<div class='btns'>" +
    "<button class='btn' onclick='copyUrl()' id='copyBtn'>Copy addon URL</button>" +
    "<a class='install btn' href='" +
    installHref +
    "'>Install in Stremio</a>" +
    "<button class='btn-ghost' onclick='window.open(\"" +
    manifestUrl +
    "\")'>Open manifest</button>" +
    "</div></div>" +
    "<div class='card'><h2>Add a plugin</h2>" +
    "<form id='f'><input type='text' id='u' placeholder='https://github.com/user/repo/tree/main/plugin-folder'>" +
    "<input type='password' id='t' placeholder='token (optional)' title='Admin token, if ADMIN_TOKEN is set'>" +
    "<button class='btn' type='submit'>Add plugin</button></form>" +
    "<p id='msg'></p></div>" +
    "<div class='card'><h2>Installed plugins (" +
    plugins.size +
    ")</h2><ul>" +
    (items.length
      ? items.join("")
      : "<li class='plug'><span class='sub'>none yet — paste a URL above</span></li>") +
    "</ul></div>" +
    "<footer>This URL updates whenever you add or remove a plugin — share it and users always see the current catalogs. " +
    "Plugins are shared by everyone who installs this addon. Set <code>ADMIN_TOKEN</code> to require the token field for add/remove.</footer>" +
    "</div><script>" +
    "const url=document.getElementById('url'),f=document.getElementById('f'),u=document.getElementById('u')," +
    "t=document.getElementById('t'),m=document.getElementById('msg');" +
    "try{t.value=localStorage.getItem('token')||''}catch(e){}" +
    "t.oninput=()=>{try{localStorage.setItem('token',t.value)}catch(e){}}" +
    "const hdr=()=>{const h={'Content-Type':'application/json'};if(t.value.trim())h['x-admin-token']=t.value.trim();return h};" +
    "async function copyUrl(){const b=document.getElementById('copyBtn');" +
    "try{await navigator.clipboard.writeText(url.value)}catch(e){url.select();document.execCommand('copy')}" +
    "b.textContent='copied!';setTimeout(()=>b.textContent='Copy addon URL',1500)}" +
    "f.onsubmit=async e=>{e.preventDefault();m.className='';m.textContent='installing…';" +
    "try{const r=await fetch('/add-plugin',{method:'POST',headers:hdr(),body:JSON.stringify({url:u.value})});" +
    "const j=await r.json();m.className=j.error?'err':'ok';" +
    "m.textContent=j.error?'FAILED: '+j.error:j.name+' is live — new addon URL generated';" +
    "if(!j.error)setTimeout(()=>location.reload(),900)}catch(e2){m.className='err';m.textContent='FAILED: '+e2.message}}" +
    "async function removePlugin(n){const r=await fetch('/remove-plugin/'+n,{method:'DELETE',headers:hdr()});" +
    "const j=await r.json();if(j.error){m.className='err';m.textContent='FAILED: '+j.error}else location.reload()}" +
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
    urlVersion++;
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
  urlVersion++;
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

async function resolveStreams(plugin, metaId, season, episode) {
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
  return raw;
}

async function handleStream(req, res, type, id) {
  const m = /^(.*):(\d+):(\d+)$/.exec(id);
  const metaId = m ? m[1] : id;
  const season = m ? +m[2] : null;
  const episode = m ? +m[3] : null;
  const plugin = pluginForId(metaId);
  if (!plugin) return sendJson(res, 404, { error: "no plugin for id: " + id });
  const base = publicBase(req);

  // cache the resolved stream list (signed URLs last ~1h; 10 min TTL is safe)
  const cached = plugin.streamCache.get(id);
  let raw =
    cached && Date.now() - cached.ts < CACHE_TTL_MS ? cached.value : null;
  if (!raw) {
    raw = await resolveStreams(plugin, metaId, season, episode);
    cachePut(plugin.streamCache, id, Date.now(), raw);
  }
  if (!raw.length) return sendJson(res, 404, { error: "no streams found" });
  sendJson(res, 200, {
    streams: raw
      .filter((s) => s && s.url)
      .map((s) => mapStream(s, base, plugin.name)),
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
      return res.end(homePage(req));
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
        // canonical refresh signal: bump on every plugin add/remove
        version: "0." + urlVersion + ".0",
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
