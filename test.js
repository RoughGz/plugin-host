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

// ---------- 1. mini-dom unit tests ----------

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

// ---------- 2. server integration ----------

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
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(hangDir, { recursive: true });
  fs.writeFileSync(
    path.join(testDir, "plugin.js"),
    'globalThis.getHome = function(cb){ cb({success:true, data:{Leaks:[{url:"https://x.test/1", title: "proc=" + typeof process + " require=" + typeof require + " fs=" + typeof fs + " buffer=" + typeof Buffer + " fetch=" + typeof fetch}]}}); };\n' +
      'globalThis.load = function(url, cb){ cb({success:true, data:{url:url, title:"Isolation Meta", type:"movie", episodes:[{name:"E1", url:"https://x.test/1/e", season:1, episode:1}]}}); };\n' +
      'globalThis.loadStreams = function(url, cb){ cb({success:true, data:[{url:"https://x.test/stream.mp4", source:"Test", quality:"1080p"}]}); };\n',
  );
  fs.writeFileSync(
    path.join(hangDir, "plugin.js"),
    "globalThis.getHome = function(cb){ while(true){} };\n",
  );

  console.log("server:");
  const server = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT), CALL_TIMEOUT_MS: "15000" },
  });
  server.stdout.on("data", (d) => process.stdout.write("[server] " + d));
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
    20000,
    "server boot",
  );
  if (!started) {
    server.kill();
    console.error("server failed to boot (port " + PORT + " in use?)");
    process.exit(1);
  }

  try {
    // hot reload should pick up the temp plugins
    const manifest = await getJson(base + "/manifest.json");
    const catIds = manifest.catalogs.map((c) => c.id);
    check(
      "manifest catalogs listed",
      catIds.length > 0,
      "got: " + catIds.join(", "),
    );
    check(
      "temp plugin hot-loaded",
      catIds.includes("__test___leaks"),
      "got: " + catIds.join(", "),
    );

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

    // meta + stream round-trip on the isolation plugin
    const meta = await getJson(
      base + "/meta/movie/" + encodeURIComponent("https://x.test/1") + ".json",
    );
    check(
      "meta videos",
      Array.isArray(meta.meta.videos) && meta.meta.videos.length === 1,
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
      } catch (e) {
        warn(pluginName + " e2e: " + e.message);
      }
    }
    if (!tested.size) {
      console.log(
        "  no plugins installed to test (run: node add-plugin.js <plugin.js raw URL>)",
      );
    }

    // web UI flow: POST a github tree URL → plugin goes live → DELETE removes it
    console.log("web add/remove:");
    try {
      const treeUrl =
        "https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/zinkmovies";
      const addRes = await fetch(base + "/add-plugin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: treeUrl }),
      });
      const add = await addRes.json();
      check(
        "web add plugin (" + treeUrl.slice(0, 50) + "...)",
        addRes.ok && add.ok && add.name === "zinkmovies",
        JSON.stringify(add),
      );
      const live = await waitFor(
        async () => {
          try {
            const m = await getJson(base + "/manifest.json");
            return m.catalogs.some((c) => c.id.startsWith("zinkmovies_"));
          } catch (e) {
            return false;
          }
        },
        30000,
        "zinkmovies catalog in manifest",
      );
      check("zinkmovies live after web add", live);
      if (live) {
        try {
          const m = await getJson(base + "/manifest.json");
          const zkCat = m.catalogs.find((c) => c.id.startsWith("zinkmovies_"));
          const items = await getJson(
            base + "/catalog/" + zkCat.type + "/" + zkCat.id + ".json",
          );
          const item = (items.metas || [])[0];
          check(
            "zinkmovies catalog items",
            !!item && !!item.name,
            JSON.stringify(item),
          );
          if (item) {
            const streams = await getJson(
              base +
                "/stream/" +
                (item.type || zkCat.type) +
                "/" +
                encodeURIComponent(item.id) +
                ".json",
            );
            check(
              "zinkmovies streams",
              Array.isArray(streams.streams) && streams.streams.length > 0,
              JSON.stringify(streams).slice(0, 200),
            );
          }
        } catch (e) {
          warn("zinkmovies e2e: " + e.message);
        }
      }
      const rmRes = await fetch(base + "/remove-plugin/zinkmovies", {
        method: "DELETE",
      });
      const rm = await rmRes.json();
      check("web remove plugin", rmRes.ok && rm.ok, JSON.stringify(rm));
      const gone = await waitFor(
        async () => {
          try {
            const m = await getJson(base + "/manifest.json");
            return !m.catalogs.some((c) => c.id.startsWith("zinkmovies_"));
          } catch (e) {
            return false;
          }
        },
        15000,
        "zinkmovies gone from manifest",
      );
      check("zinkmovies gone after remove", gone);
    } catch (e) {
      warn("web add/remove: " + e.message);
    }

    // cleanup
  } finally {
    server.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(hangDir, { recursive: true, force: true });
  }
  await sleep(800);

  console.log(failures ? "\n" + failures + " FAILURES" : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test crash:", e);
  process.exit(1);
});
