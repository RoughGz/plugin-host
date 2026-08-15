# Plugin Host

A Stremio addon that runs [Skystream](https://github.com/akashdh11/skystream)
plugins in a sandboxed environment — **zero dependencies** (Node ≥ 18 built-ins
only).

Every plugin runs in its own **worker thread + `vm` context**: no `process`, no
`require`, no `fs`, no network except through the host's `http_get`/`http_post`
bridge. Hung plugins (infinite loops) are killed by a call timeout and
automatically respawned.

> **Security note (read this).** The `vm` sandbox is _not_ a security boundary
> on its own — a malicious plugin could escape it and reach the worker thread.
> `--disallow-code-generation-from-strings` is set at runtime (blocks the
> classic `Buffer.constructor("return process")()` escape, while plugin code and
> in-sandbox `eval` still work), and only the operator can install plugins
> (`plugins.txt`). Only install plugins you trust.

## Add a plugin (plugins.txt only)

**The one and only way — a plain text file.** Edit `plugins.txt` in the repo,
one URL per line. Order matters: the first plugin's catalogs appear on top in
Stremio, the second below, etc. Save → the running server installs and reloads
automatically (on Render: edit the file on GitHub and push — auto-deploy does
the rest):

```
https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/zinkmovies
https://github.com/likhithkrishna1103-tech/Hindmovie/tree/main/anikage
```

Any URL form works: `github.com/.../tree/<branch>/<folder>`,
`github.com/.../blob/<branch>/<folder>/plugin.js`,
`raw.githubusercontent.com/.../plugin.js`. Lines starting with `#` are comments.
Only GitHub URLs are installable. Removing a line (or pushing a redeploy without
it) removes that plugin.

The addon's web page (`/`) shows the install URL with **Copy addon URL** and
**Install in Stremio** buttons. There is no web add/remove — `plugins.txt` is
the source of truth for what's installed.

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
add-plugin.js      CLI: paste raw plugin.js URL → plugins/<name>/ (offline only)
lib/worker.js      sandbox thread (vm context + host globals)
lib/plugin-host.js worker lifecycle, timeout kill/respawn
lib/mini-dom.js    dependency-free HTML parser + selector engine
test.js            self-checks
plugins/           one folder per plugin (plugin.js + plugin.json)
```
