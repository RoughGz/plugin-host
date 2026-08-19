


"use strict";
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = "http://127.0.0.1:" + PORT;
let passed = 0;
let skipped = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log("PASS " + name);
  } else {
    failed++;
    console.log("FAIL " + name + (extra ? " — " + extra : ""));
  }
}
function skip(name, why) {
  skipped++;
  console.log("SKIP " + name + " — " + why);
}

function get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

async function main() {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (c) => (logs += c));
  server.stderr.on("data", (c) => (logs += c));

  
  let started = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await get(BASE + "/", 2000);
      if (r.status === 200) {
        started = true;
        break;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!started) {
    server.kill();
    console.error("server failed to boot:\n" + logs);
    process.exit(1);
  }

  try {
    
    const dash = await get(BASE + "/");
    check(
      "dashboard serves",
      dash.status === 200 && dash.body.includes("Plugin Bridge"),
    );

    

    
    const SKY = BASE + "/plugin/" + Buffer.from("https://raw.githubusercontent.com/RougheHz/pluginsforsky/main/dist/com.cookie.moviblast.sky").toString("base64url");
    const nope = await get(BASE + "/nope/manifest.json");
    check("unknown slug 404s", nope.status === 404);

    try {
      const r = await get(
        BASE +
          "/api/plugins-from-url?url=" +
          encodeURIComponent(
            "https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/repo.json",
          ),
        60000,
      );
      const j = JSON.parse(r.body);
      check(
        "repo.json URL lists plugins",
        r.status === 200 && Array.isArray(j.plugins) && j.plugins.length > 0,
      );
    } catch (e) {
      skip("repo.json", "upstream unreachable: " + e.message);
    }

    
    let manifest = null;
    try {
      const r = await get(SKY + "/manifest.json", 60000);
      manifest = JSON.parse(r.body);
      check("manifest 200", r.status === 200);
      check(
        "manifest has catalogs",
        Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0,
      );
    } catch (e) {
      skip("manifest", "upstream unreachable: " + e.message);
    }

    
    if (manifest && manifest.catalogs.length) {
      try {
        const r = await get(
          BASE +
            SKY + "/catalog/" +
            manifest.catalogs[0].type +
            "/" +
            manifest.catalogs[0].id +
            ".json",
          60000,
        );
        const cat = JSON.parse(r.body);
        check(
          "catalog 200 with metas",
          r.status === 200 && Array.isArray(cat.metas) && cat.metas.length > 0,
        );
      } catch (e) {
        skip("catalog", "upstream unreachable: " + e.message);
      }
    }

    
    
    const fakeId =
      "https://app.cloud-mb.xyz/api/media/detail/99999/zzztestid1234567890";
    const t0 = Date.now();
    const meta = await get(
      SKY + "/meta/movie/" + encodeURIComponent(fakeId) + ".json",
      15000,
    );
    const elapsed = Date.now() - t0;
    const metaBody = JSON.parse(meta.body);
    check("meta fake id 200", meta.status === 200);
    check("meta fake id under 5s (" + elapsed + "ms)", elapsed < 5000);
    check(
      "meta has a name",
      metaBody.meta &&
        typeof metaBody.meta.name === "string" &&
        metaBody.meta.name.length > 0,
    );

    
    const b64 = Buffer.from(
      "https://raw.githubusercontent.com/RougheHz/pluginsforsky/main/dist/com.cookie.moviblast.sky",
    ).toString("base64url");
    try {
      const r = await get(BASE + "/plugin/" + b64 + "/manifest.json", 60000);
      const m = JSON.parse(r.body);
      check(
        "b64 plugin URL manifest 200",
        r.status === 200 && Array.isArray(m.catalogs),
      );
    } catch (e) {
      skip("b64 plugin URL", "upstream unreachable: " + e.message);
    }

    
    const b64js = Buffer.from(
      "https://raw.githubusercontent.com/RougheHz/pluginsforsky/main/Movieblast/plugin.js",
    ).toString("base64url");
    try {
      const r = await get(BASE + "/plugin/" + b64js + "/manifest.json", 60000);
      const m = JSON.parse(r.body);
      check(
        "plain plugin.js manifest 200",
        r.status === 200 && Array.isArray(m.catalogs) && m.catalogs.length > 0,
      );
    } catch (e) {
      skip("plain plugin.js", "upstream unreachable: " + e.message);
    }

    
    try {
      const r = await get(
        BASE +
          "/api/plugins-from-url?url=" +
          encodeURIComponent("https://github.com/RougheHz/pluginsforsky"),
        30000,
      );
      const d = JSON.parse(r.body);
      check(
        "bundle repo URL lists plugins",
        r.status === 200 &&
          Array.isArray(d.plugins) &&
          d.plugins.length > 0 &&
          d.plugins.every((p) => p.name && /^https?:\/\//.test(p.url)),
      );
    } catch (e) {
      skip("bundle repo URL", "upstream unreachable: " + e.message);
    }
  } finally {
    server.kill();
    if (failed) console.error("--- server logs ---\n" + logs);
  }

  console.log(
    "\n" + passed + " passed, " + skipped + " skipped, " + failed + " failed",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
