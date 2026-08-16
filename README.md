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
> in-sandbox `eval` still work). Only install plugins you trust. If the addon is
> publicly reachable, set the `ADMIN_TOKEN` env var — the management API then
> requires it (`x-admin-token` header; the dashboard asks for it once).

## Manage plugins from the dashboard (no config files)

The web page (`/`) is the plugin manager. Paste a GitHub plugin URL → the plugin
is fetched, validated, and goes live instantly with **its own unique addon
URL**:

```
https://your-host.onrender.com/<plugin-id>/manifest.json
```

- Add as many plugins as you want — each gets its own URL, installable in
  Stremio independently (its manifest only lists that plugin's catalogs).
- The dashboard shows every plugin as a card: status, catalogs, its addon URL
  with **Copy link** / **Install in Stremio** buttons, and **Remove**.
- `/manifest.json` (all plugins) still works for existing installs.
- State lives in `data/plugins.json` (app-managed, gitignored). On first boot
  after upgrading, an old `plugins.txt` is migrated automatically, then
  forgotten.

Any URL form works: `github.com/.../tree/<branch>/<folder>`,
`github.com/.../blob/<branch>/<folder>/plugin.js`,
`raw.githubusercontent.com/.../plugin.js`. Only GitHub URLs are installable.

Any plugin that exports `getHome` / `search` / `load` / `loadStreams` works:
getHome sections become catalogs, load feeds meta (with episodes), loadStreams
feeds streams.

> **Render note:** the free tier's filesystem is ephemeral — plugins added via
> the dashboard survive restarts but are reset on redeploy. Re-add them from the
> dashboard after a deploy (or add a persistent disk / DB later if that
> matters).

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
server.js          engine: plugin registry, management API, per-plugin addon
                   URLs, catalog/meta/stream routing, magic-URL proxy
public/            dashboard (index.html, app.js, styles.css)
lib/worker.js      sandbox thread (vm context + host globals)
lib/plugin-host.js worker lifecycle, timeout kill/respawn
lib/plugin-url.js  GitHub URL normalization + plugin source fetching
lib/mini-dom.js    dependency-free HTML parser + selector engine
test.js            self-checks
data/plugins.json  app-managed plugin state (gitignored)
plugins/           one folder per plugin (plugin.js + plugin.json)
```
