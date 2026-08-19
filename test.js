// Bridge self-test: boots the stateless server and exercises the addon
// protocol. Network-dependent checks degrade to SKIP when the upstream is
// unreachable; the meta-timing check (the Nuvio 5s cap) always runs.
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

  // wait for boot
  let started = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await get(BASE + "/api/plugins", 2000);
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
    // static dashboard
    const dash = await get(BASE + "/");
    check(
      "dashboard serves",
      dash.status === 200 && dash.body.includes("Plugin Bridge"),
    );

    // config list
    const api = await get(BASE + "/api/plugins");
    const plugins = JSON.parse(api.body).plugins || [];
    check(
      "api/plugins lists movieblast",
      api.status === 200 && plugins.some((p) => p.id === "movieblast"),
    );

    // unknown slug
    const nope = await get(BASE + "/nope/manifest.json");
    check("unknown slug 404s", nope.status === 404);

    // manifest (network: fetches the .sky bundle)
    let manifest = null;
    try {
      const r = await get(BASE + "/movieblast/manifest.json", 60000);
      manifest = JSON.parse(r.body);
      check("manifest 200", r.status === 200);
      check(
        "manifest has catalogs",
        Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0,
      );
    } catch (e) {
      skip("manifest", "upstream unreachable: " + e.message);
    }

    // catalog (network)
    if (manifest && manifest.catalogs.length) {
      try {
        const r = await get(
          BASE +
            "/movieblast/catalog/" +
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

    // meta timing: the Nuvio 5s cap — a fake id must answer fast with the
    // generic fallback, never wait for the slow upstream load
    const fakeId =
      "https://app.cloud-mb.xyz/api/media/detail/99999/zzztestid1234567890";
    const t0 = Date.now();
    const meta = await get(
      BASE + "/movieblast/meta/movie/" + encodeURIComponent(fakeId) + ".json",
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

    // b64 form: plugin URL carried in the path (no config)
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
