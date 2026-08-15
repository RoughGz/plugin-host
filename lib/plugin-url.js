// URL normalization + plugin download, shared by the web UI (server.js) and the CLI (add-plugin.js).
// Accepts: github.com tree/blob folder URLs, raw.githubusercontent.com URLs, any https URL to a plugin.js.

function normalizePluginUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);

  if (u.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4) return null; // user/repo/branch/...
    if (path.endsWith("/plugin.js"))
      return "https://raw.githubusercontent.com" + path;
    return "https://raw.githubusercontent.com" + path + "/plugin.js";
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

  // any other host: must point straight at a plugin.js file
  if (path.endsWith("/plugin.js")) return u.origin + path;
  return null;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  return res.text();
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
  const urlPath = new URL(url).pathname.replace(/\/+$/, "");
  const segments = urlPath.split("/").filter(Boolean);
  const dir = segments[segments.length - 2]; // .../<branch>/<pluginDir>/plugin.js
  if (!dir || !/^[a-zA-Z0-9_-]+$/.test(dir)) {
    throw new Error("cannot derive plugin name from URL: " + rawUrl);
  }
  const base = url.slice(0, -"plugin.js".length);
  const target = require("node:path").join(pluginsDir, dir);
  require("node:fs").mkdirSync(target, { recursive: true });
  try {
    const pj = await fetchText(base + "plugin.json");
    require("node:fs").writeFileSync(
      require("node:path").join(target, "plugin.json"),
      pj,
    );
  } catch (e) {
    /* plugin.json optional */
  }
  const js = await fetchText(base + "plugin.js");
  require("node:fs").writeFileSync(
    require("node:path").join(target, "plugin.js"),
    js,
  );
  return { name: dir, dir };
}

module.exports = { normalizePluginUrl, installPlugin };
