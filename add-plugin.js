#!/usr/bin/env node
// Add a Skystream plugin by pasting its raw plugin.js URL:
//   node add-plugin.js https://raw.githubusercontent.com/<user>/<repo>/main/<folder>/plugin.js
// Downloads plugin.js (and sibling plugin.json if present) into plugins/<folder>/.
// The running server hot-reloads automatically. Usage: node add-plugin.js <url> [<url>...] | --list
const fs = require("node:fs");
const path = require("node:path");

const PLUGINS_DIR = path.join(__dirname, "plugins");

function list() {
  console.log("installed plugins:");
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !fs.existsSync(path.join(PLUGINS_DIR, entry.name, "plugin.js"))
    )
      continue;
    let name = entry.name;
    try {
      const pj = JSON.parse(
        fs.readFileSync(
          path.join(PLUGINS_DIR, entry.name, "plugin.json"),
          "utf8",
        ),
      );
      name = pj.name || name;
    } catch (e) {
      /* no plugin.json */
    }
    console.log("  - " + entry.name + "  (" + name + ")");
  }
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  return res.text();
}

async function add(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    throw new Error("invalid URL: " + rawUrl);
  }
  if (!u.pathname.endsWith("/plugin.js"))
    throw new Error("URL must point to a plugin.js file: " + rawUrl);
  const dir = u.pathname.split("/").slice(-2)[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(dir))
    throw new Error("cannot derive plugin name from URL: " + rawUrl);
  const base = rawUrl.slice(0, -"plugin.js".length);
  const target = path.join(PLUGINS_DIR, dir);
  fs.mkdirSync(target, { recursive: true });
  try {
    const pj = await fetchText(base + "plugin.json");
    fs.writeFileSync(path.join(target, "plugin.json"), pj);
    console.log("  plugin.json saved");
  } catch (e) {
    console.log(
      "  no plugin.json (" + e.message + ") — manifest defaults will be used",
    );
  }
  const js = await fetchText(base + "plugin.js");
  fs.writeFileSync(path.join(target, "plugin.js"), js);
  console.log('added plugin "' + dir + '" → plugins/' + dir + "/plugin.js");
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      "usage: node add-plugin.js <raw-plugin.js-url> [<url>...]  |  --list",
    );
    process.exit(args[0] === "--list" ? 0 : 1);
  }
  if (args[0] === "--list") {
    list();
    return;
  }
  for (const url of args) {
    try {
      await add(url);
    } catch (e) {
      console.error("FAILED:", e.message);
      process.exitCode = 1;
    }
  }
})();
