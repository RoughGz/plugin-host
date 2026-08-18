// Self-checks: node test.js — mini-dom units, sandbox isolation, hang-kill,
// and end-to-end against the real server for every installed plugin.
// Network-dependent checks degrade to warnings instead of failures.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseHtml, parse_html, unpackJs } = require("./lib/mini-dom");

const PORT = 3999;
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("  ok  " + name);
  else {
    failures++;
    console.error("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}
function warn(name) {
  console.log("  SKIP " + name + " (network-dependent)");
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  return res.json();
}

function domTests() {
  console.log("mini-dom:");
  const doc = parseHtml(
    '<div class="a"><h2 id="t">Hello <b>World</b></h2><ul><li class="row">Name</li><li class="row">X</li></ul><div class="post-cards"><article>One</article></div></div>',
  );
  check("querySelector .class", !!doc.querySelector(".post-cards"));
  check(
    "querySelectorAll li.row == 2",
    doc.querySelectorAll("li.row").length === 2,
  );
  check(
    "#id + textContent",
    doc.querySelector("#t").textContent.trim() === "Hello World",
  );
  check(
    "descendant selector",
    (doc.querySelector("div ul li") || {}).textContent?.trim() === "Name",
  );
  check("> child combinator", doc.querySelectorAll("div > h2").length === 1);
  check(":contains", doc.querySelectorAll("li:contains(Name)").length === 1);
  check(
    ":contains quoted",
    doc.querySelectorAll('li:contains("Name")').length === 1,
  );
  check("tag.class", doc.querySelectorAll("li.row").length === 2);
  check("getAttribute", doc.querySelector("#t").getAttribute("id") === "t");
  check("tagName uppercase", doc.querySelector("h2").tagName === "H2");
  check(
    "parentElement",
    doc.querySelector("#t").parentElement.tagName === "DIV",
  );
  check(
    "nextElementSibling",
    doc.querySelector("h2").nextElementSibling.tagName === "UL",
  );
  check(
    "Array.from(nodelist)",
    Array.from(doc.querySelectorAll("li")).length === 2,
  );
  check(
    "innerHTML",
    doc.querySelector("h2").innerHTML === "Hello <b>World</b>",
  );
  check(
    "textContent nested",
    doc.querySelector(".post-cards").textContent.trim() === "One",
  );
  check(
    "entities",
    parseHtml("<p>a &amp; b &lt;c&gt; &quot;q&quot; &#65;</p>").textContent ===
      'a & b <c> "q" A',
  );
  check(
    "attr quote styles",
    parseHtml(`<a href="x" data-y='z' data-n=3></a>`)
      .querySelector("a")
      .getAttribute("data-y") === "z",
  );
  check(
    "script raw text",
    parseHtml("<script>if (a < b) { x(); }</script>")
      .querySelector("script")
      .textContent.includes("a < b"),
  );
  const rows = parse_html(
    '<div class="r" data-id="7"><span>Hi</span></div><div class="r">Yo</div>',
    ".r",
    "data-id",
  );
  check("parse_html rows", rows.length === 2);
  check("parse_html attr", rows[0].attr === "7");
  check("parse_html text", rows[1].text === "Yo");
  const packed =
    "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?\"\":e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)d[c]=k[c]||c;k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p}('0 1 2',5,3,'hello|brave|world'.split('|'),0,{}))";
  check("unpackJs", unpackJs(packed) === "hello brave world");
}

// ---------- 1.5 URL normalization unit tests ----------

function urlTests() {
  console.log("plugin-url:");
  const { normalizePluginUrl } = require("./lib/plugin-url");
  const cases = [
    // github tree folder URL → raw plugin.js (the "paste a link" flow)
    [
      "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/zinkmovies",
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/zinkmovies/plugin.js",
    ],
    // github blob URL straight to plugin.js
    [
      "https://github.com/likhithkrishna1103-tech/Hindmovie/blob/main/anikage/plugin.js",
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/anikage/plugin.js",
    ],
    // raw URL as-is
    [
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/anikage/plugin.js",
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/anikage/plugin.js",
    ],
    // raw folder URL (missing plugin.js)
    [
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/anikage/",
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/anikage/plugin.js",
    ],
    // trailing slash + query noise
    [
      "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/zinkmovies/?tab=readme-ov-file",
      "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/zinkmovies/plugin.js",
    ],
  ];
  for (const [input, expected] of cases) {
    check(
      "normalize " + input.slice(0, 60) + "...",
      normalizePluginUrl(input) === expected,
      "got: " + normalizePluginUrl(input),
    );
  }
  check(
    "normalize rejects junk",
    normalizePluginUrl("not a url") === null &&
      normalizePluginUrl("https://example.com/foo") === null,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs, what) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(300);
  }
  console.error("  timed out waiting for " + what);
  return false;
}

async function main() {
  domTests();
  urlTests();

  const testDir = path.join(__dirname, "plugins", "__test__");
  const hangDir = path.join(__dirname, "plugins", "__hang__");
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(hangDir, { recursive: true, force: true });
  // leftover plugin dirs from local runs (e.g. plugins/moviblast) would be
  // hot-loaded as dev plugins and shadow the test's catalog checks
  for (const entry of fs.readdirSync(path.join(__dirname, "plugins"), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory() && !entry.name.startsWith("__"))
      fs.rmSync(path.join(__dirname, "plugins", entry.name), {
        recursive: true,
        force: true,
      });
  }
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(hangDir, { recursive: true });
  fs.writeFileSync(
    path.join(testDir, "plugin.js"),
    'globalThis.getHome = function(cb){ var esc = "?"; try { Buffer.constructor("return 1")(); esc = "escaped"; } catch (e) { esc = "blocked"; } cb({success:true, data:{Leaks:[{url:"https://x.test/1", title: "proc=" + typeof process + " require=" + typeof require + " fs=" + typeof fs + " buffer=" + typeof Buffer + " fetch=" + typeof fetch + " esc=" + esc}]}}); };\n' +
      'globalThis.load = function(url, cb){ cb({success:true, data:{url:url, title:"Isolation Meta", type:"movie", episodes:[{name:"E1", url:"https://x.test/1/e", season:1, episode:1}]}}); };\n' +
      'globalThis.loadStreams = function(url, cb){ cb({success:true, data:[{url:"https://x.test/stream.mp4", source:"Test", quality:"1080p"}]}); };\n',
  );
  fs.writeFileSync(
    path.join(hangDir, "plugin.js"),
    "globalThis.getHome = function(cb){ while(true){} };\n",
  );
  // warm-failure stub: first getHome returns a section, later ones return
  // success-with-empty (what blocked/flaky upstreams do) — catalogs must
  // survive the re-warm
  const warmDir = path.join(__dirname, "plugins", "__warmfail__");
  fs.rmSync(warmDir, { recursive: true, force: true });
  fs.mkdirSync(warmDir, { recursive: true });
  fs.writeFileSync(
    path.join(warmDir, "plugin.js"),
    "var n = 0;\n" +
      'globalThis.getHome = function(cb){ n++; if (n === 1) cb({success:true, data:{Keep:[{url:"https://warmfail.test/keep", title:"Keep Me"}]}}); else cb({success:true, data:{}}); };\n',
  );

  // seed plugins: two real plugins, zinkmovies first → its catalogs must
  // appear on top. Written as the legacy plugins.txt so boot exercises the
  // one-time migration into data/plugins.json. Network-dependent: boot
  // survives, checks degrade to SKIP.
  const statePath = path.join(__dirname, "data", "plugins.json");
  const stateBackup = fs.existsSync(statePath)
    ? fs.readFileSync(statePath, "utf8")
    : null;
  fs.rmSync(statePath, { force: true });
  fs.writeFileSync(
    path.join(__dirname, "plugins.txt"),
    "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/zinkmovies\n" +
      "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/anikage\n",
  );

  console.log("server:");
  const server = spawn(
    "node",
    ["--disallow-code-generation-from-strings", "server.js"],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        CALL_TIMEOUT_MS: "15000",
        CACHE_TTL_MS: "1500", // fast TTL so the warm-failure re-warm test runs quickly
      },
    },
  );
  let serverOut = "";
  server.stdout.on("data", (d) => {
    serverOut += d;
    process.stdout.write("[server] " + d);
  });
  server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  const base = "http://localhost:" + PORT;
  const started = await waitFor(
    async () => {
      try {
        await getJson(base + "/manifest.json");
        return true;
      } catch (e) {
        return false;
      }
    },
    45000,
    "server boot",
  );
  if (!started) {
    server.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(hangDir, { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, "plugins.txt"), { force: true });
    if (stateBackup === null) fs.rmSync(statePath, { force: true });
    else fs.writeFileSync(statePath, stateBackup);
    console.error("server failed to boot (port " + PORT + " in use?)");
    process.exit(1);
  }

  try {
    // hot reload should pick up the temp plugins (warm runs in the
    // background now, so poll until the stub's catalog appears)
    const booted = await waitFor(
      async () => {
        try {
          const m = await getJson(base + "/manifest.json");
          return m.catalogs.some((c) => c.id === "__test___leaks");
        } catch (e) {
          return false;
        }
      },
      45000,
      "catalogs after boot",
    );
    const manifest = await getJson(base + "/manifest.json");
    const catIds = manifest.catalogs.map((c) => c.id);
    check(
      "manifest catalogs listed",
      booted && catIds.length > 0,
      "got: " + catIds.join(", "),
    );
    check("temp plugin hot-loaded", booted, "got: " + catIds.join(", "));

    // warm-failure resilience: a re-warm that returns no sections must NOT
    // wipe existing catalogs (blocked/flaky upstreams return success+empty)
    const warmCatId = "__warmfail___keep";
    check(
      "warmfail stub has catalog at boot",
      catIds.includes(warmCatId),
      "got: " + catIds.join(", "),
    );
    await sleep(2000); // let CACHE_TTL_MS (1.5s) expire
    await getJson(base + "/catalog/movie/" + warmCatId + ".json"); // triggers re-warm → getHome returns {}
    const manifest2 = await getJson(base + "/manifest.json");
    check(
      "catalogs survive empty re-warm",
      manifest2.catalogs.some((c) => c.id === warmCatId),
      "got: " + manifest2.catalogs.map((c) => c.id).join(", "),
    );

    // plugins.txt migration: catalog order follows file order (zinkmovies first, anikage second)
    const zkIdx = catIds.findIndex((id) => id.startsWith("zinkmovies_"));
    const akIdx = catIds.findIndex((id) => id.startsWith("anikage_"));
    const zkLast = catIds
      .map((id, i) => (id.startsWith("zinkmovies_") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    if (zkIdx === -1 || akIdx === -1) {
      warn("plugins.txt migration (network): " + catIds.join(", "));
    } else {
      check(
        "catalog order = plugins.txt order",
        zkLast < akIdx,
        "zinkmovies ends at " + zkLast + ", anikage starts at " + akIdx,
      );
    }

    // sandbox isolation: process/require/fs must be invisible
    const cat = await getJson(base + "/catalog/movie/__test___leaks.json");
    const first = (cat.metas || [])[0] || {};
    check(
      "sandbox isolates process",
      first.name && first.name.includes("proc=undefined"),
      JSON.stringify(first.name),
    );
    check(
      "sandbox isolates require",
      first.name && first.name.includes("require=undefined"),
    );
    check(
      "sandbox isolates fs",
      first.name && first.name.includes("fs=undefined"),
    );
    check(
      "sandbox provides Buffer",
      first.name && first.name.includes("buffer=function"),
    );
    check(
      "sandbox has no raw fetch",
      first.name && first.name.includes("fetch=undefined"),
    );
    check(
      "sandbox blocks constructor escape",
      first.name && first.name.includes("esc=blocked"),
      JSON.stringify(first.name),
    );

    // meta + stream round-trip on the isolation plugin
    const meta = await getJson(
      base + "/meta/movie/" + encodeURIComponent("https://x.test/1") + ".json",
    );
    check(
      "meta videos",
      Array.isArray(meta.meta.videos) && meta.meta.videos.length === 1, // movie with episodes -> 1 video (S1E1)
    );
    const streams = await getJson(
      base +
        "/stream/movie/" +
        encodeURIComponent("https://x.test/1") +
        ".json",
    );
    check(
      "stream url passthrough",
      Array.isArray(streams.streams) &&
        streams.streams[0].url === "https://x.test/stream.mp4",
    );

    // hang plugin: infinite loop must be killed, server must survive
    const hangOk = await waitFor(
      async () => {
        try {
          const m2 = await getJson(base + "/manifest.json");
          return !m2.catalogs.some((c) => c.id.startsWith("__hang__"));
        } catch (e) {
          return false;
        }
      },
      15000,
      "hang plugin killed (no __hang__ catalogs)",
    );
    check("hung plugin killed by timeout", hangOk);
    try {
      await getJson(base + "/manifest.json");
      check("server alive after hang", true);
    } catch (e) {
      check("server alive after hang", false, e.message);
    }

    // E2E for every installed plugin (network-dependent → warnings)
    const pluginDirs = fs
      .readdirSync(path.join(__dirname, "plugins"), { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          fs.existsSync(path.join(__dirname, "plugins", d.name, "plugin.js")),
      )
      .map((d) => d.name);
    const tested = new Set();
    for (const cat of manifest.catalogs) {
      const pluginName =
        pluginDirs.find(
          (d) => !d.startsWith("__") && cat.id.startsWith(d + "_"),
        ) || cat.id.split("_")[0];
      if (!pluginName || pluginName.startsWith("__") || tested.has(pluginName))
        continue;
      tested.add(pluginName);
      console.log(pluginName + ":");
      try {
        const items = await getJson(
          base + "/catalog/" + cat.type + "/" + cat.id + ".json",
        );
        const item = (items.metas || [])[0];
        check(
          pluginName + " catalog items",
          !!item && !!item.name,
          JSON.stringify(item),
        );
        if (!item) continue;
        const meta = await getJson(
          base +
            "/meta/" +
            (item.type || cat.type) +
            "/" +
            encodeURIComponent(item.id) +
            ".json",
        );
        const videos = (meta.meta && meta.meta.videos) || [];
        check(pluginName + " meta", !!meta.meta && !!meta.meta.name);
        const isSeries = (item.type || cat.type) === "series";
        const ep = videos[0] || {};
        const streamId = isSeries
          ? item.id + ":" + (ep.season || 1) + ":" + (ep.episode || 1)
          : item.id;
        const streams = await getJson(
          base +
            "/stream/" +
            (item.type || cat.type) +
            "/" +
            encodeURIComponent(streamId) +
            ".json",
        );
        check(
          pluginName + " streams",
          Array.isArray(streams.streams) && streams.streams.length > 0,
          JSON.stringify(streams).slice(0, 200),
        );
        // search route: both the plugin's own catalog (?search=) and the
        // global Stremio search entry point (top.json?search=) must answer
        const term = encodeURIComponent(
          String(item.name || "the").split(" ")[0],
        );
        const s1 = await getJson(
          base +
            "/catalog/" +
            (item.type || cat.type) +
            "/" +
            cat.id +
            ".json?search=" +
            term,
        );
        const s2 = await getJson(
          base +
            "/catalog/" +
            (item.type || cat.type) +
            "/top.json?search=" +
            term,
        );
        check(
          pluginName + " search",
          Array.isArray(s1.metas) && Array.isArray(s2.metas),
        );
      } catch (e) {
        warn(pluginName + " e2e: " + e.message);
      }
    }
    if (!tested.size) {
      console.log(
        "  no plugins installed to test (add one from the dashboard)",
      );
    }

    // dashboard API is the only way to add/remove plugins: POST a GitHub URL,
    // the plugin goes live with its own unique addon URL; DELETE removes it.
    console.log("dashboard API flow:");
    try {
      const addRes = await fetch(base + "/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/movies4u",
        }),
      });
      const added = await addRes.json();
      check(
        "plugin added via API",
        addRes.status === 201 && !!added.plugin && !!added.plugin.id,
        JSON.stringify(added).slice(0, 200),
      );
      if (addRes.status === 201) {
        const pid = added.plugin.id;
        const catIds = added.plugin.catalogs.map((c) => c.id);
        // unique addon URL serves a manifest with only that plugin's catalogs
        const m = await getJson(base + "/" + pid + "/manifest.json");
        check(
          "unique addon URL works",
          m.catalogs.length > 0 &&
            m.catalogs.every((c) => catIds.includes(c.id)),
          JSON.stringify(m.catalogs).slice(0, 200),
        );
        // duplicate add → 409
        const dup = await fetch(base + "/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/movies4u",
          }),
        });
        check("duplicate add rejected", dup.status === 409);
        // list includes it
        const list = await getJson(base + "/api/plugins");
        check(
          "list includes plugin",
          list.plugins.some((p) => p.id === pid),
        );
        // bundles: unique addon URL for a selection of plugins
        const bAdd = await fetch(base + "/api/bundles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginIds: [pid] }),
        });
        const bData = await bAdd.json();
        check(
          "bundle created",
          bAdd.status === 201 && !!bData.bundle && !!bData.bundle.id,
          JSON.stringify(bData).slice(0, 200),
        );
        let bUrl = null;
        if (bAdd.status === 201) {
          bUrl = bData.bundle.url;
          const bm = await getJson(bUrl);
          check(
            "bundle manifest serves only selected plugins",
            bm.catalogs.length > 0 &&
              bm.catalogs.every((c) => catIds.includes(c.id)),
            JSON.stringify(bm.catalogs).slice(0, 200),
          );
          const bList = await getJson(base + "/api/bundles");
          check(
            "bundle listed",
            bList.bundles.some((b) => b.id === bData.bundle.id),
          );
        }
        // remove via API → gone from the all-plugins manifest
        const del = await fetch(base + "/api/plugins/" + pid, {
          method: "DELETE",
        });
        check("plugin removed via API", del.status === 200);
        const gone = await waitFor(
          async () => {
            try {
              const m2 = await getJson(base + "/manifest.json");
              return !m2.catalogs.some((c) => catIds.includes(c.id));
            } catch (e) {
              return false;
            }
          },
          15000,
          "plugin gone from manifest",
        );
        check("plugin gone from manifest", gone);
        if (bUrl) {
          // bundle pruned with its plugin → URL dead
          const bGone = await fetch(bUrl);
          check("bundle URL dead after plugin removed", bGone.status === 404);
          const bDel = await fetch(base + "/api/bundles/" + bData.bundle.id, {
            method: "DELETE",
          });
          check("bundle deleted", bDel.status === 200);
        }
      }
    } catch (e) {
      warn("dashboard API flow: " + e.message);
    }
    // ----- deterministic coverage of otherwise-untested paths (no network) -----
    console.log("hardening checks:");
    // /proxy/ SSRF: loopback, IPv6 literal, metadata — all must be refused
    for (const bad of [
      "http://127.0.0.1:3999/manifest.json",
      "http://[::1]:3999/manifest.json",
      "http://[::ffff:127.0.0.1]:3999/manifest.json",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3999/manifest.json",
    ]) {
      const enc = Buffer.from(bad).toString("base64url");
      const r = await fetch(base + "/proxy/" + enc, {
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      const body = r ? await r.json().catch(() => ({})) : {};
      check(
        "proxy blocks " + bad.slice(0, 40),
        r && r.status === 502 && /blocked/.test(body.error || ""),
        r ? r.status + " " + (body.error || "") : "fetch failed",
      );
    }
    // proxy passes a public URL through (may fail to connect here → still 502,
    // but must NOT be "blocked host")
    {
      const enc = Buffer.from("https://new1.vegamovies.futbol/").toString(
        "base64url",
      );
      const r = await fetch(base + "/proxy/" + enc, {
        signal: AbortSignal.timeout(20000),
      }).catch(() => null);
      check(
        "proxy allows public host",
        r && r.status !== 502,
        "status " + (r && r.status),
      );
    }
    // magic-URL m3u8 rewrite: MAGIC_PROXY_v2 lines become /proxy/ URLs
    {
      const m3u =
        "#EXTM3U\nMAGIC_PROXY_v2" +
        Buffer.from("https://cdn.example/seg.mp4").toString("base64url");
      const enc = Buffer.from(m3u).toString("base64url");
      const r = await fetch(base + "/proxy/" + enc, {
        signal: AbortSignal.timeout(10000),
      });
      const txt = await r.text();
      check(
        "magic m3u8 lines rewritten to proxy",
        r.status === 200 &&
          txt.includes("/proxy/") &&
          !txt.includes("MAGIC_PROXY_v2"),
        txt.slice(0, 120),
      );
    }
    // split-id series stream: <metaId>:1:1 → episodes[0] → loadStreams
    {
      const r = await fetch(
        base +
          "/stream/series/" +
          encodeURIComponent("https://x.test/1") +
          ":1:1.json",
        { signal: AbortSignal.timeout(15000) },
      );
      const j = await r.json().catch(() => ({}));
      check(
        "split-id series stream resolves",
        r.status === 200 &&
          Array.isArray(j.streams) &&
          j.streams[0].url === "https://x.test/stream.mp4",
        r.status + " " + JSON.stringify(j).slice(0, 100),
      );
    }
    // catalog extras: skip=1 on a 1-item catalog must be empty, genre filter
    // must narrow (item has no tags → everything filtered out)
    {
      const full = await getJson(base + "/catalog/movie/__test___leaks.json");
      const skipped = await getJson(
        base + "/catalog/movie/__test___leaks.json?skip=1",
      );
      const genre = await getJson(
        base + "/catalog/movie/__test___leaks.json?genre=xyz",
      );
      check(
        "skip pagination honored",
        full.metas.length === 1 && skipped.metas.length === 0,
        "full=" + full.metas.length + " skip=" + skipped.metas.length,
      );
      check(
        "genre filter honored",
        genre.metas.length === 0,
        "genre=" + genre.metas.length,
      );
    }
    // stateless bundle: urls form → encoded /bundle/auto/ URL → manifest works
    // (bundle creation is local; serving it installs from GitHub — network)
    {
      const add = await fetch(base + "/api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: [
            "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/movies4u",
          ],
        }),
      });
      const d = await add.json();
      check(
        "stateless bundle created",
        add.status === 201 && /\/bundle\/auto\//.test(d.bundle.url),
        JSON.stringify(d).slice(0, 120),
      );
      if (add.status === 201) {
        try {
          const m = await getJson(d.bundle.url);
          check(
            "stateless bundle manifest serves",
            Array.isArray(m.catalogs) && m.catalogs.length > 0,
            JSON.stringify(m.catalogs).slice(0, 100),
          );
        } catch (e) {
          warn("stateless bundle serve: " + e.message);
        }
      }
    }
  } finally {
    server.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(hangDir, { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, "plugins", "zinkmovies"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(__dirname, "plugins", "anikage"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(__dirname, "plugins.txt"), { force: true });
    if (stateBackup === null) fs.rmSync(statePath, { force: true });
    else fs.writeFileSync(statePath, stateBackup);
  }
  await sleep(800);

  console.log(failures ? "\n" + failures + " FAILURES" : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test crash:", e);
  process.exit(1);
});
