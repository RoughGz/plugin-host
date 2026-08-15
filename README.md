# Plugin Host

A Stremio addon that runs [Skystream](https://github.com/akashdh11/skystream)
plugins in a fully sandboxed environment — **zero dependencies** (Node ≥ 18
built-ins only).

Every plugin runs in its own **worker thread + `vm` context**: no `process`, no
`require`, no `fs`, no network except through the host's `http_get`/`http_post`
bridge. Hung plugins (infinite loops) are killed by a call timeout and
automatically respawned.

## Add a plugin by pasting a raw URL

```bash
node add-plugin.js https://raw.githubusercontent.com/likhithkrishna1103-tech/Hindmovie/main/anikage/plugin.js
```

Downloads `plugin.js` (and its `plugin.json` if present) into `plugins/<name>/`.
The running server hot-reloads — no restart needed. Add several at once, or list
installed:

```bash
node add-plugin.js <url1> <url2> ...
node add-plugin.js --list
```

Any plugin that exports `getHome` / `search` / `load` / `loadStreams` works:
getHome sections become catalogs, load feeds meta (with episodes), loadStreams
feeds streams.

## Run

```bash
npm start            # listens on $PORT or 3999
npm test             # sandbox isolation + hang-kill + E2E for installed plugins
```

`config.json` — addon identity. Set `publicUrl` (or the `PUBLIC_URL` env var) to
your deployed URL so magic proxy URLs (`MAGIC_PROXY_*`, `magic_m3u8:`) are
rewritten to `<publicUrl>/proxy/...`.

## Sandbox host globals (Skystream contract)

`http_get` / `http_post` / `http_parallel`, `parseHtml` (DOM:
querySelector/querySelectorAll with `:contains`, `>` and descendant selectors),
`parse_html`, `getAndUnpack`, `crypto.decryptAES` / `crypto.pbkdf2`,
`getPreference` / `setPreference`, `nativeRegex` / `nativeJsonExtract` /
`nativeMd5` / `nativeSha256`, `solveCaptcha` (mock), `atob` / `btoa` / `Buffer`
/ `TextDecoder` / `URL`, timers, `manifest` (the plugin's plugin.json), and the
entity classes `MultimediaItem`, `Episode`, `StreamResult`, `Actor`, `Trailer`,
`NextAiring`, `SubtitleFile`. Calls may be callback-style or promise-style.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New Web Service → connect the repo.
3. Build: `npm install` — Start: `npm start`.
4. Set env var `PUBLIC_URL` to your Render URL (e.g.
   `https://plugin-host.onrender.com`).
5. Free tier idles after 15 min — add an UptimeRobot 5-min monitor on
   `/manifest.json`.

## Layout

```
server.js          engine: catalog/meta/stream routing, magic-URL proxy, hot reload
add-plugin.js      CLI: paste raw plugin.js URL → plugins/<name>/
lib/worker.js      sandbox thread (vm context + host globals)
lib/plugin-host.js worker lifecycle, timeout kill/respawn
lib/mini-dom.js    dependency-free HTML parser + selector engine
test.js            self-checks
plugins/           one folder per plugin (plugin.js + plugin.json)
```
