const fs = require("node:fs");
const path = require("node:path");

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

// Derive the plugin folder name from any accepted URL form. Returns null if unusable.
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

// Download plugin.js (+ sibling plugin.json if present) into plugins/<dir>/.
// Returns { name, dir }. Throws on failure.
async function installPlugin(rawUrl, pluginsDir) {
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
  const dir = pluginNameFromUrl(rawUrl);
  if (!dir) {
    throw new Error("cannot derive plugin name from URL: " + rawUrl);
  }
  const base = url.slice(0, -"plugin.js".length);
  const target = path.join(pluginsDir, dir);
  fs.mkdirSync(target, { recursive: true });
  try {
    const pj = await fetchText(base + "plugin.json");
    fs.writeFileSync(path.join(target, "plugin.json"), pj);
  } catch (e) {
    // plugin.json optional
  }
  const js = await fetchText(base + "plugin.js");
  fs.writeFileSync(path.join(target, "plugin.js"), js);
  return { name: dir, dir };
}

module.exports = {
  normalizePluginUrl,
  pluginNameFromUrl,
  installPlugin,
};
