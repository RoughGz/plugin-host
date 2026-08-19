const zlib = require("zlib");
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, redirectsLeft = 5) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: ac.signal,
    });
    
    
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || redirectsLeft <= 0)
        throw new Error(url + " → too many redirects");
      const next = new URL(loc, url).href;
      if (!isAllowedHost(next))
        throw new Error(url + " → redirect to disallowed host: " + next);
      return fetchWithTimeout(next, redirectsLeft - 1);
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

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
    if (parts.length < 4) return null; 
    if (pathname.endsWith("/plugin.js"))
      return "https://raw.githubusercontent.com" + pathname;
    return "https://raw.githubusercontent.com" + pathname + "/plugin.js";
  }

  if (u.hostname === "github.com") {
    if (parts.length < 4) return null; 
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

  
  if (pathname.endsWith("/plugin.js")) return u.origin + pathname;
  return null;
}


function isAllowedHost(url) {
  const host = new URL(url).hostname;
  return host === "github.com" || host === "raw.githubusercontent.com";
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_PLUGIN_BYTES) throw new Error(url + " → response too large");
  const text = await res.text();
  if (text.length > MAX_PLUGIN_BYTES)
    throw new Error(url + " → response too large");
  return text;
}

async function fetchBuffer(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_PLUGIN_BYTES) throw new Error(url + " → response too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PLUGIN_BYTES)
    throw new Error(url + " → response too large");
  return buf;
}



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
  let total = 0;
  const maxEntries = 64; 
  const n = Math.min(cdCount, maxEntries);
  for (let i = 0; i < n; i++) {
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
    
    
    
    let data;
    if (method === 0) data = raw;
    else
      data = zlib.inflateRawSync(raw, {
        maxOutputLength: MAX_PLUGIN_BYTES - total,
      });
    if (data.length > MAX_PLUGIN_BYTES - total) break;
    total += data.length;
    files[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}







async function resolveGithubUrl(url) {
  const u = new URL(url);
  if (u.hostname === "raw.githubusercontent.com") return url;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("cannot understand URL: " + url);
  const [user, repo, kind, ref, ...rest] = parts;
  if (kind === "blob")
    return (
      "https://raw.githubusercontent.com/" +
      user +
      "/" +
      repo +
      "/" +
      [ref, ...rest].join("/")
    );
  if (kind === "tree") return resolveDir(user, repo, ref, rest.join("/"));
  if (parts.length === 2) return resolveDir(user, repo, "HEAD", "");
  throw new Error("cannot understand URL: " + url);
}

async function resolveDir(user, repo, ref, dirPath) {
  const api =
    "https://api.github.com/repos/" +
    user +
    "/" +
    repo +
    "/contents/" +
    dirPath +
    (ref && ref !== "HEAD" ? "?ref=" + encodeURIComponent(ref) : "");
  const res = await fetch(api, { headers: { "User-Agent": "plugin-host" } });
  if (!res.ok) throw new Error(api + " -> HTTP " + res.status);
  const entries = await res.json();
  if (!Array.isArray(entries)) {
    const msg = (entries && entries.message) || "not a directory";
    throw new Error(
      "no plugin.js in " + (dirPath || "repo root") + " - " + msg,
    );
  }
  const target =
    entries.find((e) => e.type === "file" && e.name === "plugin.js") ||
    entries.find((e) => e.type === "file" && e.name.endsWith(".sky"));
  if (!target)
    throw new Error(
      "no plugin.js (or .sky) in " +
        (dirPath || "repo root") +
        " - files: " +
        entries.map((e) => e.name).join(", "),
    );
  return target.download_url;
}






const providerCache = new Map();
async function expandProviders(url, name) {
  if (providerCache.has(url)) return providerCache.get(url);
  const out = [{ name, url }];
  try {
    let desc = null;
    if (/\.sky$/i.test(url)) {
      const buf = await fetchBuffer(url);
      if (buf[0] === 0x50 && buf[1] === 0x4b) {
        const files = unzip(buf);
        if (files["plugin.json"])
          desc = JSON.parse(files["plugin.json"].toString("utf8"));
      }
    } else {
      desc = JSON.parse(await fetchText(url.replace(/plugin\.js$/i, "plugin.json")));
    }
    if (desc && Array.isArray(desc.providers) && desc.providers.length > 1) {
      out.length = 0;
      for (const prov of desc.providers) {
        if (!prov || !prov.id) continue;
        out.push({
          name: prov.name || prov.id,
          url: url + (url.includes("?") ? "&" : "?") + "provider=" + encodeURIComponent(prov.id),
        });
      }
    }
  } catch (e) {}
  providerCache.set(url, out);
  return out;
}

async function listPluginsInGithub(rawUrl) {
  const url = String(rawUrl).trim();
  if (!/^https?:\/\//.test(url))
    throw new Error("cannot understand URL: " + rawUrl);
  if (!isAllowedHost(url)) {
    throw new Error(
      "only github.com / raw.githubusercontent.com installs are allowed",
    );
  }
  const u = new URL(url);
  const base = (s) => (s.split("?")[0] || "").split("/").pop();
  const stem = (s) => String(s).replace(/\.(sky|js)$/i, "");
  if (u.hostname === "raw.githubusercontent.com") {
    const file = base(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const folder = parts.length > 2 ? parts[parts.length - 2] : "";
    const name =
      file === "plugin.js" && folder ? folder : stem(file) || "plugin";
    return [{ name, url }];
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("cannot understand URL: " + url);
  const [user, repo, kind, ref, ...rest] = parts;
  if (kind === "blob") {
    const file = rest[rest.length - 1] || "";
    const folder = rest.length > 1 ? rest[rest.length - 2] : "";
    return [
      {
        name: folder || stem(file) || "plugin",
        url:
          "https://raw.githubusercontent.com/" + user + "/" + repo + "/" +
          [ref, ...rest].join("/"),
      },
    ];
  }
  let branch, dir;
  if (kind === "tree") {
    branch = ref;
    dir = rest.join("/");
  } else if (parts.length === 2) {
    branch = "HEAD";
    dir = "";
  } else {
    throw new Error("cannot understand URL: " + url);
  }
  const api = (b) =>
    "https://api.github.com/repos/" + user + "/" + repo + "/git/trees/" +
    encodeURIComponent(b) + "?recursive=1";
  let res = await fetch(api(branch), { headers: { "User-Agent": "plugin-host" } });
  if (!res.ok && branch !== "master")
    res = await fetch(api("master"), { headers: { "User-Agent": "plugin-host" } });
  if (!res.ok)
    throw new Error(
      "repo not found or private (make it public): " + user + "/" + repo,
    );
  const data = await res.json();
  const tree = Array.isArray(data.tree) ? data.tree : [];
  const prefix = dir ? dir + "/" : "";
  const lower = prefix.toLowerCase();
  const depth = dir ? dir.split("/").length : 0;
  const out = [];
  for (const t of tree) {
    if (t.type !== "blob") continue;
    const path = t.path;
    if (dir && !path.toLowerCase().startsWith(lower)) continue;
    let rel = path;
    if (dir) {
      let idx = -1;
      for (let i = 0; i < depth; i++) idx = path.indexOf("/", idx + 1);
      rel = path.slice(idx + 1);
    }
    if (!rel || rel.split("/").length > 2) continue;
    const raw =
      "https://raw.githubusercontent.com/" + user + "/" + repo + "/" +
      branch + "/" + path;
    if (rel.endsWith(".sky")) out.push({ name: stem(rel), url: raw });
    else if (rel === "plugin.js")
      out.push({ name: dir || "plugin", url: raw });
    else if (rel.endsWith("/plugin.js"))
      out.push({ name: rel.split("/")[0], url: raw });
  }
  if (!out.length)
    throw new Error("no plugin.js or .sky files under " + (dir || "repo root"));
  const expanded = [];
  for (const p of out) expanded.push(...(await expandProviders(p.url, p.name)));
  return expanded;
}

async function fetchPluginSourceFromSky(rawUrl, name) {
  const url = String(rawUrl).trim();
  if (!/^https?:\/\//.test(url))
    throw new Error("cannot understand URL: " + rawUrl);
  if (!isAllowedHost(url)) {
    throw new Error(
      "only github.com / raw.githubusercontent.com installs are allowed",
    );
  }
  const buf = await fetchBuffer(await resolveGithubUrl(url));
  let code;
  let descriptor = {};
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    
    const files = unzip(buf);
    code = files["plugin.js"];
    if (!code) throw new Error("bundle has no plugin.js: " + rawUrl);
    if (files["plugin.json"]) {
      try {
        descriptor = JSON.parse(files["plugin.json"].toString("utf8"));
      } catch (e) {}
    }
  } else {
    
    code = buf;
    const base = url.split("/").pop().split("?")[0] || "";
    descriptor = { name: base.replace(/\.js$/i, "") || "plugin" };
  }
  const provId = new URL(url).searchParams.get("provider");
  if (provId) {
    descriptor.providerId = provId;
    const prov = (descriptor.providers || []).find((x) => x.id === provId);
    if (prov && prov.baseUrl) descriptor.baseUrl = prov.baseUrl;
  }
  
  
  return {
    name: name || descriptor.name || "plugin",
    code: code.toString("utf8"),
    descriptor,
  };
}

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
      const base = {
        name: p.name || p.packageName || "plugin",
        url: p.url,
        description: p.description || "",
        categories: Array.isArray(p.categories) ? p.categories : [],
      };
      for (const e of await expandProviders(p.url, base.name))
        plugins.push({ ...base, name: e.name, url: e.url });
    }
  }
  return {
    name: repo.name || "repo",
    description: repo.description || "",
    plugins,
  };
}

function pluginNameFromUrl(rawUrl) {
  const url = normalizePluginUrl(rawUrl);
  if (!url) return null;
  const segments = new URL(url).pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  const dir = segments[segments.length - 2]; 
  return dir && /^[a-zA-Z0-9_-]+$/.test(dir) ? dir : null;
}

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
  } catch (e) {}
  const code = await fetchText(base + "plugin.js");
  return { name, code, descriptor };
}

module.exports = {
  normalizePluginUrl,
  pluginNameFromUrl,
  fetchPluginSource,
  fetchPluginSourceFromSky,
  listPluginsInGithub,
  listPluginsInGithub,
  fetchRepoPlugins,
};
