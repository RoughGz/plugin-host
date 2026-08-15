#!/usr/bin/env node
// Add a Skystream plugin by pasting a URL:
//   node add-plugin.js https://github.com/<user>/<repo>/tree/<branch>/<folder>
// Downloads plugin.js (and sibling plugin.json if present) into plugins/<folder>/.
// The running server hot-reloads automatically. Usage: node add-plugin.js <url> [<url>...] | --list
const fs = require("node:fs");
const path = require("node:path");
const { installPlugin, appendToPluginsTxt } = require("./lib/plugin-url");

const PLUGINS_DIR = path.join(__dirname, "plugins");
const PLUGINS_FILE = path.join(__dirname, "plugins.txt");

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
      // no plugin.json
    }
    console.log("  - " + entry.name + "  (" + name + ")");
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    list();
    return;
  }
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      "usage: node add-plugin.js <plugin-url> [<url>...]  |  --list\n" +
        "  <plugin-url> = github.com/.../tree/<branch>/<folder> | github.com/.../blob/<branch>/<folder>/plugin.js | raw.githubusercontent.com/.../plugin.js",
    );
    process.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 1);
  }
  for (const url of args) {
    try {
      const { name } = await installPlugin(url, PLUGINS_DIR);
      appendToPluginsTxt(PLUGINS_FILE, url); // keep plugins.txt in sync (survives redeploy)
      console.log(
        'added plugin "' + name + '" → plugins/' + name + "/plugin.js",
      );
    } catch (e) {
      console.error("FAILED:", e.message);
      process.exitCode = 1;
    }
  }
})();
