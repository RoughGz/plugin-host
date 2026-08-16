const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseHtml: parseHtmlImpl,
  parse_html: parse_htmlImpl,
  unpackJs,
} = require("./mini-dom");

const { code, manifest, defaults } = workerData;
const storageFile = defaults && defaults.storageFile;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

async function httpRequest(method, url, headers, body) {
  const ctrl = new AbortController();
  // slow upstreams (search APIs especially) routinely take >15s from
  // datacenter IPs; the per-plugin call timeout still bounds the whole call
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const h = {};
    if (headers)
      for (const [k, v] of Object.entries(headers))
        if (v !== undefined && v !== null) h[k] = String(v);
    if (defaults.verifyUA) {
      if (!h["User-Agent"] && !h["user-agent"])
        h["User-Agent"] = defaults.verifyUA;
    } else if (!h["User-Agent"] && !h["user-agent"]) {
      h["User-Agent"] = DEFAULT_UA;
    }
    if (!h["Accept-Encoding"] && !h["accept-encoding"])
      h["Accept-Encoding"] = "identity";
    if (
      (method === "POST" || method === "PUT") &&
      body &&
      !h["Content-Type"] &&
      !h["content-type"]
    )
      h["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, {
      method,
      headers: h,
      body: body || undefined,
      redirect: "follow",
      signal: ctrl.signal,
    });
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BODY_BYTES)
      return {
        code: 0,
        statusCode: 0,
        status: 0,
        body: "",
        error: "response too large",
      };
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES)
      return {
        code: 0,
        statusCode: 0,
        status: 0,
        body: "",
        error: "response too large",
      };
    const outHeaders = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = outHeaders[k] ? outHeaders[k] + "," + v : v;
    });
    return {
      code: res.status,
      statusCode: res.status,
      status: res.status,
      body: text,
      headers: outHeaders,
      finalUrl: res.url,
    };
  } catch (e) {
    return {
      code: 0,
      statusCode: 0,
      status: 0,
      body: "",
      error: String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function http_get(url, headers, cb) {
  return httpRequest("GET", url, headers, null).then((res) => {
    if (typeof cb === "function") cb(res);
    return res;
  });
}

function http_post(url, headers, body, cb) {
  // legacy quirk preserved from the Dart host: (url, body, headers) form
  if (
    headers &&
    typeof headers === "object" &&
    !body &&
    (headers.body !== undefined || headers.headers)
  ) {
    body = headers.body;
    headers = headers.headers;
  }
  return httpRequest("POST", url, headers, body).then((res) => {
    if (typeof cb === "function") cb(res);
    return res;
  });
}

function http_parallel(requests) {
  return Promise.all(
    (requests || [])
      .slice(0, 10)
      .map((r) =>
        httpRequest(
          (r && r.method) || "GET",
          r && r.url,
          (r && r.headers) || {},
          r && r.body,
        ),
      ),
  );
}

const webcrypto = {
  async decryptAES(data, key, iv, options) {
    const mode = (options && options.mode) || "cbc";
    const keyBuf = Buffer.from(key, "base64");
    const ivBuf = Buffer.from(iv || "", "base64");
    const dataBuf = Buffer.from(data, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-" + keyBuf.length * 8 + "-" + mode,
      keyBuf,
      ivBuf,
    );
    return Buffer.concat([decipher.update(dataBuf), decipher.final()]).toString(
      "utf8",
    );
  },
  async pbkdf2(password, salt, iterations, keyLength) {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        password,
        Buffer.from(salt, "base64"),
        iterations,
        keyLength,
        "sha256",
        (e, k) => (e ? reject(e) : resolve(k.toString("base64"))),
      );
    });
  },
};

const prefs = new Map();
function getPreference(key) {
  return prefs.has(key) ? prefs.get(key) : "";
}
function setPreference(key, value) {
  prefs.set(key, value);
  return true;
}

// persistent key/value storage bridge (plugins like netmirror cache their
// upstream token here so they don't re-mint on every worker restart)
const storage = new Map();
function loadStorage() {
  if (storage.size || !storageFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(storageFile, "utf8"));
    for (const [k, v] of Object.entries(raw)) storage.set(k, v);
  } catch (e) {
    // no file yet — first run
  }
}
function get_storage(req) {
  loadStorage();
  const v = storage.get(String((req && req.key) || ""));
  return v === undefined ? null : v;
}
function set_storage(req) {
  const k = String((req && req.key) || "");
  const v = String((req && req.value) ?? "");
  storage.set(k, v);
  if (storageFile) {
    try {
      fs.mkdirSync(path.dirname(storageFile), { recursive: true });
      fs.writeFileSync(
        storageFile,
        JSON.stringify(Object.fromEntries(storage)),
      );
    } catch (e) {
      // storage is best-effort — never break the plugin call over it
    }
  }
  return true;
}

function nativeRegex(text, pattern, group, caseSensitive) {
  try {
    const re = new RegExp(pattern, caseSensitive === false ? "gi" : "g");
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push(m[group] !== undefined ? m[group] : m[0]);
      if (m[0] === "") re.lastIndex++;
    }
    return out;
  } catch (e) {
    return [];
  }
}

function extractPath(cur, parts) {
  for (const part of parts) {
    const idxM = /^(.*)\[(\d+)\]$/.exec(part);
    if (idxM) {
      cur = cur && cur[idxM[1]] ? cur[idxM[1]][+idxM[2]] : undefined;
      continue;
    }
    if (part.endsWith("[*]")) {
      cur = cur && cur[part.slice(0, -3)];
      continue;
    }
    cur = cur ? cur[part] : undefined;
  }
  return cur;
}

function nativeJsonExtract(jsonStr, paths) {
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    return [];
  }
  return (paths || []).map((p) => {
    const v = extractPath(obj, String(p).split("."));
    return v === undefined ? null : v;
  });
}

function nativeMd5(s) {
  return crypto.createHash("md5").update(String(s)).digest("hex");
}
function nativeSha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function solveCaptcha(siteKey, url) {
  return Promise.resolve("mock_captcha_token");
}

class Actor {
  constructor(p) {
    Object.assign(this, p);
  }
}
class Trailer {
  constructor(p) {
    Object.assign(this, p);
  }
}
class NextAiring {
  constructor(p) {
    Object.assign(this, p);
  }
}
class SubtitleFile {
  constructor(p) {
    Object.assign(this, p);
  }
}
class MultimediaItem {
  constructor(params) {
    Object.assign(this, {
      type: "movie",
      status: "ongoing",
      playbackPolicy: "none",
      isAdult: false,
      streams: [],
      syncData: {},
      ...params,
    });
  }
}
class Episode {
  constructor(params) {
    Object.assign(this, {
      season: 0,
      episode: 0,
      dubStatus: "none",
      playbackPolicy: "none",
      streams: [],
      ...params,
    });
  }
}
class StreamResult {
  constructor(p = {}) {
    this.url = p.url;
    this.source = p.source || "Auto";
    this.headers = p.headers;
    this.subtitles = p.subtitles;
    this.drmKid = p.drmKid;
    this.drmKey = p.drmKey;
    this.licenseUrl = p.licenseUrl;
  }
}

const sandbox = {
  console: {
    log: (...a) => console.log("[plugin]", ...a),
    error: (...a) => console.error("[plugin]", ...a),
    warn: (...a) => console.warn("[plugin]", ...a),
  },
  Buffer,
  atob,
  btoa,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  manifest: manifest || {},
  CloudStream: { getLanguage: () => "en", getRegion: () => "US" },
  Actor,
  Trailer,
  NextAiring,
  SubtitleFile,
  MultimediaItem,
  Episode,
  StreamResult,
  http_get,
  http_post,
  http_parallel,
  crypto: webcrypto,
  getAndUnpack: (js) => unpackJs(String(js)),
  parseHtml: (html) => Promise.resolve(parseHtmlImpl(html)),
  parse_html: (html, selector, attr) =>
    Promise.resolve(parse_htmlImpl(html, selector, attr)),
  getPreference,
  setPreference,
  get_storage,
  set_storage,
  nativeRegex,
  nativeJsonExtract,
  nativeMd5,
  nativeSha256,
  solveCaptcha,
};
sandbox.global = sandbox;

const ctx = vm.createContext(sandbox);

let loadError = null;
try {
  vm.runInContext(code, ctx, { timeout: 10000 });
} catch (e) {
  loadError = String((e && e.message) || e);
}

const API_NAMES = [
  "getHome",
  "search",
  "getSearch",
  "load",
  "loadStreams",
  "getLatest",
  "getDiscover",
];
const api = loadError
  ? []
  : API_NAMES.filter((f) => typeof ctx[f] === "function");

parentPort.postMessage({ type: "ready", api, error: loadError });

function invoke(fn, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, value, error) => {
      if (!settled) {
        settled = true;
        resolve({ ok, value, error });
      }
    };
    try {
      const result = fn(...args, (v) =>
        finish(true, v === undefined ? "__dart_void__" : v),
      );
      if (result && typeof result.then === "function") {
        result.then(
          (v) => {
            if (v !== undefined) finish(true, v);
          },
          (e) => finish(false, undefined, String((e && e.message) || e)),
        );
      }
    } catch (e) {
      finish(false, undefined, String((e && e.message) || e));
    }
  });
}

// JSON-safe clone so postMessage never fails on functions/circular refs
function safeClone(v, seen) {
  if (v === null || typeof v !== "object") return v;
  if (typeof v === "function") return undefined;
  seen = seen || new Set();
  if (seen.has(v)) return null;
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => safeClone(x, seen));
  const out = {};
  for (const k of Object.keys(v)) out[k] = safeClone(v[k], seen);
  return out;
}

function postResult(msg) {
  if (msg.ok && msg.value !== undefined) {
    const cloned = safeClone(msg.value);
    try {
      if (JSON.stringify(cloned).length > MAX_BODY_BYTES) {
        msg = {
          type: "result",
          id: msg.id,
          ok: false,
          error: "result too large",
        };
      } else {
        msg = { type: "result", id: msg.id, ok: true, value: cloned };
      }
    } catch (e) {
      msg = {
        type: "result",
        id: msg.id,
        ok: false,
        error: "result not serializable",
      };
    }
  }
  parentPort.postMessage(msg);
}

parentPort.on("message", async (msg) => {
  if (!msg || msg.type !== "call") return;
  const fn = ctx[msg.fn];
  if (typeof fn !== "function") {
    parentPort.postMessage({
      type: "result",
      id: msg.id,
      ok: false,
      error: "Function " + msg.fn + " not found",
    });
    return;
  }
  const r = await invoke(fn, msg.args || []);
  postResult({
    type: "result",
    id: msg.id,
    ok: r.ok,
    value: r.ok ? r.value : undefined,
    error: r.error,
  });
});
