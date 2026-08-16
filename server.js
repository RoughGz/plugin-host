const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;
const { Readable } = require("node:stream");
const { PluginRuntime, callPlugin } = require("./lib/plugin-host");
const { pluginNameFromUrl, fetchPluginSource } = require("./lib/plugin-url");

const ROOT = __dirname;
const PLUGINS_DIR = path.join(ROOT, "plugins");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "plugins.json");
fs.mkdirSync(PLUGINS_DIR, { recursive: true }); // dev/test plugins; git ignores empty dirs
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = process.env.PORT || 3999;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000;
const META_CACHE_MAX = 200;
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
  // disk wiped → GitHub mirror, then legacy plugins.txt
  if (await loadStateFromGithub()) return;
  try {
    const txt = fs.readFileSync(path.join(ROOT, "plugins.txt"), "utf8");
    const seen = new Set();
    for (const url of txt
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const name = pluginNameFromUrl(url) || "plugin";
      let id = slugify(name);
      let n = 2;
      while (seen.has(id)) id = slugify(name) + "-" + n++;
      seen.add(id);
      state.push({ id, name, url, addedAt: Date.now() });
    }
    if (state.length) {
      saveState();
      console.log("migrated", state.length, "plugins from plugins.txt");
    }
  } catch (e) {
    // no plugins.txt — fresh start, dashboard is the manager
  }
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
    }),
  };
}

function destroyPool(pool) {
  for (const p of pool.plugins.values()) if (p.runtime) p.runtime.destroy();
}

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

function uniqueId(base) {
  let id = base;
  let n = 2;
  while (plugins.has(id) || state.some((e) => e.id === id))
    id = base + "-" + n++;
  return id;
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
  const type = mapType(item.type);
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  // movies: no videos — Stremio shows one Play button and requests
  // /stream/movie/<id>. A fake "S1 E1" episode makes movies render as seasons
  const videos =
    type === "series"
      ? episodes.map((ep, i) => ({
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
        }))
      : [];
  return {
    id: item.url,
    type,
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
  for (const entry of state) {
    try {
      const { name, code, descriptor } = await fetchPluginSource(entry.url);
      const plugin = makePlugin(entry.id, name, code, descriptor);
      writePluginFiles(plugin, code, descriptor);
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
  }
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
  return [...plugins.values()];
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
      const firstType = mapType(items[0].type);
      built.set(slugify(name), { name, type: firstType, items });
    }
    if (!built.size) {
      // no sections (flaky/blocked upstream) — keep existing catalogs, stale beats empty
      plugin.sectionsTs = Date.now();
      plugin.status = "error";
      plugin.error = "getHome returned no sections";
      console.warn("plugin", plugin.name, "getHome returned no sections");
      return;
    }
    plugin.sections.clear();
    plugin.metaCache.clear();
    for (const [slug, section] of built) plugin.sections.set(slug, section);
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
  return catalogList(globalPool);
}

function rebuildPrefixMap(pool) {
  pool.prefixMap.clear();
  for (const p of pool.plugins.values()) {
    if (p.descriptor.idPrefix)
      pool.prefixMap.set(
        String(p.descriptor.idPrefix).replace(/\/$/, ""),
        p.name,
      );
    for (const { items } of p.sections.values()) {
      for (const item of items) {
        if (!item.url || typeof item.url !== "string") continue;
        try {
          const origin = new URL(item.url).origin;
          pool.prefixMap.set(origin, p.name);
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

function catalogList(pool) {
  const multi = pool.plugins.size > 1;
  const out = [];
  for (const p of pool.plugins.values()) {
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

function findCatalog(pool, catalogId) {
  for (const p of pool.plugins.values()) {
    const prefix = p.descriptor.catalogPrefix || p.name;
    if (catalogId.startsWith(prefix + "_")) {
      const section = p.sections.get(catalogId.slice(prefix.length + 1));
      if (section) return { plugin: p, section };
    }
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
  if (!plugin.runtime) return null;
  const cached = plugin.metaCache.get(metaId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  const res = await callPlugin(plugin.runtime, "load", [metaId]);
  if (!res.success || !res.data || typeof res.data !== "object") return null;
  cachePut(plugin.metaCache, metaId, Date.now(), res.data);
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

// POST /api/plugins {url} — fetch + install a plugin, return its addon URL
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
  let source;
  try {
    source = await fetchPluginSource(url);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const id = uniqueId(slugify(source.name));
  const plugin = makePlugin(id, source.name, source.code, source.descriptor);
  const pool = poolFor(plugin);
  await warmPlugin(plugin, pool);
  if (!plugin.sections.size) {
    plugin.runtime.destroy();
    return sendJson(res, 400, {
      error: "plugin has no catalogs (getHome failed?)",
    });
  }
  writePluginFiles(plugin, source.code, source.descriptor);
  state.push({ id, name: source.name, url, addedAt: Date.now() });
  saveState();
  plugins.set(id, plugin);
  rebuildPrefixMap(globalPool);
  console.log("added plugin:", id, "<-", url);
  sendJson(res, 201, { plugin: publicPlugin(state[state.length - 1], req) });
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
  rebuildPrefixMap(globalPool);
  console.log("removed plugin:", id);
  sendJson(res, 200, { ok: true });
}

// ---------- addon handlers ----------

function manifest(pool, req) {
  // self-heal: stale empty catalogs kick a background warm (Render idle spin-down)
  for (const p of pool.plugins.values()) {
    if (!p.sections.size && Date.now() - p.sectionsTs > CACHE_TTL_MS) {
      warmAll().catch(() => {});
      break;
    }
  }
  return {
    id: config.id || "com.stremio.addon",
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
  const found = findCatalog(pool, catalogId);
  let items = [];
  if (search) {
    // Stremio's global search hits /catalog/<type>/top.json?search=... (and any
    // other unknown id) — route it to the pool's plugins' search and merge
    const targets = found ? [found.plugin] : [...pool.plugins.values()];
    const seen = new Set();
    for (const p of targets) {
      if (!p.runtime) continue;
      const r = await callPlugin(p.runtime, "search", [search]);
      if (!r.success || !Array.isArray(r.data)) continue;
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
    items = found.section.items;
  }
  sendJson(res, 200, { metas: items.map(mapItem).filter((m) => m.id) });
}

async function handleMeta(req, res, type, id, pool) {
  const plugin = pluginForId(id, pool);
  if (!plugin) return sendJson(res, 404, { error: "no plugin for id: " + id });
  const item = await getRawItem(plugin, id);
  if (!item) return sendJson(res, 404, { error: "meta not found" });
  sendJson(res, 200, { meta: mapMeta(item) });
}

async function resolveStreams(plugin, metaId, season, episode) {
  if (!plugin.runtime) return [];
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

async function handleStream(req, res, type, id, pool, base) {
  const m = /^(.*):(\d+):(\d+)$/.exec(id);
  const metaId = m ? m[1] : id;
  const season = m ? +m[2] : null;
  const episode = m ? +m[3] : null;
  const plugin = pluginForId(metaId, pool);
  if (!plugin) return sendJson(res, 404, { error: "no plugin for id: " + id });

  // no stream cache on purpose: plugins hand out short-lived signed URLs
  // (e.g. moviblast verify= tokens), so mint fresh on every request
  const raw = await resolveStreams(plugin, metaId, season, episode);
  if (!raw.length) return sendJson(res, 404, { error: "no streams found" });
  sendJson(res, 200, {
    streams: raw
      .filter((s) => s && s.url)
      .map((s) => mapStream(s, base, plugin.name)),
  });
}

// ---------- magic-URL proxy ----------

function isPrivateIp(ip) {
  if (/^::ffff:/i.test(ip)) return true; // IPv4-mapped IPv6 (::ffff:127.0.0.1 etc.)
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

async function handleProxy(req, res, payloadPath) {
  const payload = decodeURIComponent(payloadPath);
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
  });
  res.end(fs.readFileSync(file));
  return true;
}

// ---------- router ----------

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
    const delM = /^\/api\/plugins\/([A-Za-z0-9_-]+)$/.exec(url);
    if (delM && req.method === "DELETE")
      return handleDeletePlugin(req, res, delM[1]);

    // ---- dashboard ----
    if (url === "/" || url === "/index.html") {
      return serveStatic(req, res, "/");
    }
    if (serveStatic(req, res, url)) return;

    // ---- per-plugin addon URLs: /<id>/<route> ----
    const pluginM = /^\/([A-Za-z0-9_-]{1,64})\/(.+)$/.exec(url);
    if (pluginM && plugins.has(pluginM[1])) {
      const id = pluginM[1];
      const rest = "/" + pluginM[2];
      const plugin = plugins.get(id);
      const pool = poolFor(plugin);
      const base = publicBase(req) + "/" + id;
      if (rest === "/manifest.json")
        return sendJson(res, 200, manifest(pool, req));
      const proxyM = /^\/proxy\/(.+)$/.exec(rest);
      if (proxyM) return handleProxy(req, res, proxyM[1]);
      const catM = /^\/catalog\/(movie|series)\/([^/]+)\.json$/.exec(rest);
      if (catM)
        return handleCatalog(
          req,
          res,
          catM[1],
          decodeURIComponent(catM[2]),
          query.get("search"),
          pool,
        );
      const metaM = /^\/meta\/(movie|series)\/([^/]+)\.json$/.exec(rest);
      if (metaM)
        return handleMeta(
          req,
          res,
          metaM[1],
          decodeURIComponent(metaM[2]),
          pool,
        );
      const streamM = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(rest);
      if (streamM)
        return handleStream(
          req,
          res,
          streamM[1],
          decodeURIComponent(streamM[2]),
          pool,
          base,
        );
      return sendJson(res, 404, { error: "not found" });
    }

    // ---- default addon (all plugins) ----
    if (url === "/manifest.json")
      return sendJson(res, 200, manifest(globalPool, req));
    const proxyM = /^\/proxy\/(.+)$/.exec(url);
    if (proxyM) return handleProxy(req, res, proxyM[1]);
    const catM = /^\/catalog\/(movie|series)\/([^/]+)\.json$/.exec(url);
    if (catM)
      return handleCatalog(
        req,
        res,
        catM[1],
        decodeURIComponent(catM[2]),
        query.get("search"),
        globalPool,
      );
    const metaM = /^\/meta\/(movie|series)\/([^/]+)\.json$/.exec(url);
    if (metaM)
      return handleMeta(
        req,
        res,
        metaM[1],
        decodeURIComponent(metaM[2]),
        globalPool,
      );
    const streamM = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(url);
    if (streamM)
      return handleStream(
        req,
        res,
        streamM[1],
        decodeURIComponent(streamM[2]),
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
if (process.env.NODE_ENV !== "production")
  fs.watch(PLUGINS_DIR, { recursive: true }, () => reloadNow());

async function boot() {
  await loadState();
  await loadFromState();
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
server.on("error", (e) => {
  console.error("server error:", e);
  if (e.code === "EADDRINUSE") process.exit(1);
});

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});
