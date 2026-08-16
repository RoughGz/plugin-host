const zlib = require("zlib");
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;

function normalizePluginUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const pathname = u.pathname.replace(/\/+$/, "");
  const parts = pathname.split("/").filter(Boolean);

  if (u.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4) return null; // user/repo/branch/...
    if (pathname.endsWith("/plugin.js"))
      return "https://raw.githubusercontent.com" + pathname;
    return "https://raw.githubusercontent.com" + pathname + "/plugin.js";
  }

  if (u.hostname === "github.com") {
    if (parts.length < 4) return null; // user/repo/tree|blob/branch/...
    const [user, repo, kind, branch, ...rest] = parts;
    if (kind !== "tree" && kind !== "blob") return null;
    const filePath = rest.join("/");
    if (filePath === "plugin.js" || filePath.endsWith("/plugin.js")) {
      return (
        "https://raw.githubusercontent.com/" +
        user +
        "/" +
        repo +
        "/" +
        branch +
        "/" +
        filePath
      );
    }
    return (
      "https://raw.githubusercontent.com/" +
      user +
      "/" +
      repo +
      "/" +
      branch +
      "/" +
      filePath +
      "/plugin.js"
    );
  }

  // other hosts: must point straight at a plugin.js file
  if (pathname.endsWith("/plugin.js")) return u.origin + pathname;
  return null;
}

// only GitHub hosts are installable; arbitrary https fetches are an SSRF path
function isAllowedHost(url) {
  const host = new URL(url).hostname;
  return host === "github.com" || host === "raw.githubusercontent.com";
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_PLUGIN_BYTES) throw new Error(url + " → response too large");
  const text = await res.text();
  if (text.length > MAX_PLUGIN_BYTES)
    throw new Error(url + " → response too large");
  return text;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_PLUGIN_BYTES) throw new Error(url + " → response too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PLUGIN_BYTES)
    throw new Error(url + " → response too large");
  return buf;
}

// minimal zip reader: central directory + zlib for deflate entries.
// .sky plugin bundles are zips containing plugin.json + plugin.js.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  const files = {};
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart =
      lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Fetch a .sky plugin bundle (zip of plugin.json + plugin.js) from a repo.
async function fetchPluginSourceFromSky(rawUrl, name) {
  const url = String(rawUrl).trim();
  if (!/^https?:\/\//.test(url))
    throw new Error("cannot understand URL: " + rawUrl);
  if (!isAllowedHost(url)) {
    throw new Error(
      "only github.com / raw.githubusercontent.com installs are allowed",
    );
  }
  const files = unzip(await fetchBuffer(url));
  const code = files["plugin.js"];
  if (!code) throw new Error("bundle has no plugin.js: " + rawUrl);
  let descriptor = {};
  if (files["plugin.json"]) {
    try {
      descriptor = JSON.parse(files["plugin.json"].toString("utf8"));
    } catch (e) {
      // plugin.json optional
    }
  }
  return { name: name || "plugin", code: code.toString("utf8"), descriptor };
}

// Fetch a repo.json (SkyStream repository) and return its plugin list.
// repo.json -> pluginLists[] -> plugins.json[] -> {name, url, ...}
async function fetchRepoPlugins(repoUrl) {
  const url = String(repoUrl).trim();
  if (!/^https?:\/\//.test(url))
    throw new Error("cannot understand URL: " + repoUrl);
  if (!isAllowedHost(url)) {
    throw new Error(
      "only github.com / raw.githubusercontent.com repos are allowed",
    );
  }
  const repo = JSON.parse(await fetchText(url));
  const lists = Array.isArray(repo.pluginLists) ? repo.pluginLists : [];
  if (!lists.length) throw new Error("repo has no pluginLists: " + repoUrl);
  const plugins = [];
  for (const listUrl of lists) {
    if (!isAllowedHost(listUrl)) {
      throw new Error("plugin list not on allowed host: " + listUrl);
    }
    const arr = JSON.parse(await fetchText(listUrl));
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (!p || typeof p.url !== "string" || !isAllowedHost(p.url)) continue;
      plugins.push({
        name: p.name || p.packageName || "plugin",
        url: p.url,
        description: p.description || "",
        categories: Array.isArray(p.categories) ? p.categories : [],
      });
    }
  }
  return {
    name: repo.name || "repo",
    description: repo.description || "",
    plugins,
  };
}

// Derive the plugin name from any accepted URL form. Returns null if unusable.
function pluginNameFromUrl(rawUrl) {
  const url = normalizePluginUrl(rawUrl);
  if (!url) return null;
  const segments = new URL(url).pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  const dir = segments[segments.length - 2]; // .../<branch>/<pluginDir>/plugin.js
  return dir && /^[a-zA-Z0-9_-]+$/.test(dir) ? dir : null;
}

// Fetch plugin.js (+ plugin.json) source without touching disk.
// Returns { name, code, descriptor }. Throws on failure.
async function fetchPluginSource(rawUrl) {
  const url = normalizePluginUrl(rawUrl);
  if (!url) {
    throw new Error(
      "cannot understand URL (expected github.com/.../tree/.../<folder>, github.com/.../blob/.../plugin.js, or raw.githubusercontent.com/.../plugin.js): " +
        rawUrl,
    );
  }
  if (!isAllowedHost(url)) {
    throw new Error(
      "only github.com / raw.githubusercontent.com installs are allowed",
    );
  }
  const name = pluginNameFromUrl(rawUrl);
  if (!name) {
    throw new Error("cannot derive plugin name from URL: " + rawUrl);
  }
  const base = url.slice(0, -"plugin.js".length);
  let descriptor = {};
  try {
    descriptor = JSON.parse(await fetchText(base + "plugin.json"));
  } catch (e) {
    // plugin.json optional
  }
  const code = await fetchText(base + "plugin.js");
  return { name, code, descriptor };
}

module.exports = {
  normalizePluginUrl,
  pluginNameFromUrl,
  fetchPluginSource,
  fetchPluginSourceFromSky,
  fetchRepoPlugins,
};
