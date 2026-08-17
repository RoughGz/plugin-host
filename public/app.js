// Plugin Host dashboard — vanilla JS, no dependencies.
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const grid = $("#grid");
  const empty = $("#empty");
  const stats = $("#stats");
  const statPlugins = $("#statPlugins");
  const statCatalogs = $("#statCatalogs");
  const statLive = $("#statLive");
  const addForm = $("#addForm");
  const urlInput = $("#urlInput");
  const addBtn = $("#addBtn");
  const addError = $("#addError");
  const toasts = $("#toasts");
  const selBar = $("#selBar");
  const selCount = $("#selCount");
  const selectAllBtn = $("#selectAll");
  const removeAllBtn = $("#removeAll");
  const makeBundle = $("#makeBundle");
  const resetBtn = $("#resetBtn");
  const bundleResult = $("#bundleResult");
  const bundleResultUrl = $("#bundleResultUrl");
  const bundleResultInstall = $("#bundleResultInstall");
  const bundleResultCopy = $("#bundleResultCopy");
  const bundleResultCopyBtn = $("#bundleResultCopyBtn");
  const bundleResultClose = $("#bundleResultClose");
  const bundlesSection = $("#bundlesSection");
  const bundleCount = $("#bundleCount");
  const bundleList = $("#bundleList");
  const repoInfo = $("#repoInfo");
  const selected = new Set();
  let lastPlugins = [];
  let repoPluginList = [];
  let lastJson = "";

  function api(path, opts = {}) {
    return fetch(path, opts);
  }

  function toast(msg, kind = "ok") {
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => el.classList.add("toast-out"), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  }

  function esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function stremioInstallUrl(addonUrl) {
    return "stremio://" + addonUrl.replace(/^https?:\/\//, "");
  }

  // shared card body for installed and repo plugins; key is the selection key
  function cardHtml({ key, name, status, error, catalogs, url, isRepo }) {
    const sel = selected.has(key);
    const statusCls =
      status === "error"
        ? "status-error"
        : status === "available"
          ? "status-avail"
          : "status-live";
    const statusTxt =
      status === "error"
        ? "Error"
        : status === "available"
          ? "Available"
          : "Live";
    return `
      <div class="card-head">
        <div class="card-title">
          <h3>${esc(name)}</h3>
          <span class="status ${statusCls}">${statusTxt}</span>
        </div>
        <div class="card-tools">
          <button class="toggle${sel ? " on" : ""}" data-toggle="${esc(key)}" aria-pressed="${sel}" title="Toggle selection" aria-label="Toggle ${esc(name)}"></button>
          <button class="btn-remove" data-remove="${esc(key)}" title="Remove" aria-label="Remove ${esc(name)}">Remove</button>
        </div>
      </div>
      ${error ? `<p class="card-error-msg">${esc(error)}</p>` : ""}
      <div class="chips">
        ${
          catalogs.length
            ? catalogs
                .map((c) => `<span class="chip">${esc(c.name)}</span>`)
                .join("")
            : '<span class="chip chip-muted">no catalogs</span>'
        }
      </div>
      <div class="url-row">
        <code class="url" title="${esc(url)}">${esc(url)}</code>
        <button class="icon-btn" data-copy="${esc(url)}" title="Copy link" aria-label="Copy link">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </div>
      <div class="card-actions">
        ${
          isRepo
            ? `<button class="btn btn-primary btn-sm" data-install="${esc(url)}">Install in Stremio</button>`
            : `<a class="btn btn-primary btn-sm" href="${esc(stremioInstallUrl(url))}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
            Install in Stremio
          </a>`
        }
        <button class="btn btn-ghost btn-sm" data-copy="${esc(url)}">Copy link</button>
      </div>`;
  }

  function render(plugins) {
    lastPlugins = plugins;
    // remove only the plugin cards — the add card lives in the grid too
    grid.querySelectorAll(".card").forEach((c) => c.remove());
    empty.hidden = plugins.length > 0;
    stats.hidden = plugins.length === 0;
    statPlugins.textContent = plugins.length;
    statCatalogs.textContent = plugins.reduce(
      (n, p) => n + p.catalogs.length,
      0,
    );
    statLive.textContent = plugins.filter((p) => p.status !== "error").length;
    for (const id of selected) {
      if (id.startsWith("repo:")) {
        // keep repo selections only while the repo plugin is still listed
        if (!repoPluginList.some((p) => "repo:" + p.url === id))
          selected.delete(id);
      } else if (!plugins.some((p) => p.id === id)) {
        selected.delete(id);
      }
    }
    updateSelBar();

    for (const p of plugins) {
      const card = document.createElement("article");
      card.className = "card" + (p.status === "error" ? " card-error" : "");
      if (selected.has(p.id)) card.classList.add("card-selected");
      card.innerHTML = cardHtml({
        key: p.id,
        name: p.name,
        status: p.status,
        error: p.error,
        catalogs: p.catalogs,
        url: p.addonUrl,
        isRepo: false,
      });
      grid.appendChild(card);
    }

    // repo plugins render as normal cards too (status/catalogs come from a
    // client-side probe of their manifest URL)
    for (const rp of repoPluginList) {
      if (plugins.some((p) => p.url === rp.url)) continue; // already installed
      const card = document.createElement("article");
      card.className = "card" + (rp.status === "error" ? " card-error" : "");
      if (selected.has("repo:" + rp.url)) card.classList.add("card-selected");
      card.innerHTML = cardHtml({
        key: "repo:" + rp.url,
        name: rp.name,
        status: rp.status,
        error: rp.error,
        catalogs: rp.catalogs,
        url: rp.url,
        isRepo: true,
      });
      grid.appendChild(card);
    }
  }

  function updateSelBar() {
    selCount.textContent =
      selected.size +
      (selected.size === 1 ? " plugin selected" : " plugins selected");
    makeBundle.disabled = selected.size === 0;
    // live preview: selected plugins and their catalogs, real-time
    const selPreview = $("#selPreview");
    if (!selected.size) {
      selPreview.hidden = true;
      selPreview.innerHTML = "";
      return;
    }
    const info = (key) =>
      key.startsWith("repo:")
        ? repoPluginList.find((p) => p.url === key.slice(5))
        : lastPlugins.find((p) => p.id === key);
    selPreview.innerHTML =
      "<div class='sel-preview-head'>Bundle preview — live catalogs</div>" +
      [...selected]
        .map((key) => {
          const p = info(key);
          if (!p) return "";
          const cats = (p.catalogs || [])
            .slice(0, 8)
            .map((c) => `<span class="chip chip-sm">${esc(c.name)}</span>`)
            .join("");
          return `<div class="sel-preview-row"><strong>${esc(p.name)}</strong><span class="chips">${cats || '<span class="chip chip-muted">no catalogs</span>'}</span></div>`;
        })
        .join("");
    selPreview.hidden = false;
  }

  async function createBundle() {
    if (!selected.size) return;
    makeBundle.disabled = true;
    try {
      // stateless bundle: the URL encodes the manifest URLs, so it survives
      // restarts. Selection is kept — nothing is removed from the list.
      const urls = [...selected]
        .map((k) => {
          if (k.startsWith("repo:")) return k.slice(5);
          const p = lastPlugins.find((x) => x.id === k);
          return p ? p.url : null;
        })
        .filter(Boolean);
      if (!urls.length) {
        toast("Nothing to bundle", "error");
        return;
      }
      const res = await api("api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      showBundleResult(data.bundle.url);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      makeBundle.disabled = false;
    }
  }

  function showBundleResult(url) {
    bundleResultUrl.textContent = url;
    bundleResultInstall.href = stremioInstallUrl(url);
    bundleResult.hidden = false;
    bundleResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderBundles(list) {
    bundlesSection.hidden = list.length === 0;
    bundleCount.hidden = list.length === 0;
    bundleCount.textContent =
      list.length + (list.length === 1 ? " bundle" : " bundles");
    bundleList.innerHTML = "";
    for (const b of list) {
      const item = document.createElement("div");
      item.className = "bundle-item";
      item.innerHTML = `
        <div class="url-row">
          <code class="url" title="${esc(b.url)}">${esc(b.url)}</code>
          <button class="icon-btn" data-bcopy="${esc(b.url)}" title="Copy URL" aria-label="Copy URL">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
        </div>
        <div class="card-actions">
          <a class="btn btn-primary btn-sm" href="${esc(stremioInstallUrl(b.url))}">Install in Stremio</a>
          <button class="btn btn-ghost btn-sm" data-bcopy="${esc(b.url)}">Copy URL</button>
          <button class="btn btn-ghost btn-sm btn-danger" data-bdel="${esc(b.id)}">Delete</button>
        </div>`;
      bundleList.appendChild(item);
    }
  }

  async function loadBundles() {
    const res = await api("api/bundles");
    if (!res.ok) return;
    const data = await res.json();
    renderBundles(data.bundles || []);
  }

  async function deleteBundle(id) {
    if (!confirm("Delete this bundle? Its addon URL will stop working."))
      return;
    const res = await api("api/bundles/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || "Delete failed", "error");
      return;
    }
    toast("Bundle deleted");
    await loadBundles();
  }

  async function load() {
    const res = await api("api/plugins");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const json = JSON.stringify(data.plugins || []);
    if (json === lastJson) return; // skip re-render (and card re-animation)
    lastJson = json;
    render(data.plugins || []);
  }

  async function addPlugin(url) {
    addBtn.disabled = true;
    addBtn.querySelector(".btn-label").hidden = true;
    addBtn.querySelector(".spinner").hidden = false;
    addError.hidden = true;
    try {
      const res = await api("api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      urlInput.value = "";
      toast("Plugin added — " + data.plugin.name);
      await load();
    } catch (e) {
      addError.textContent = e.message;
      addError.hidden = false;
    } finally {
      addBtn.disabled = false;
      addBtn.querySelector(".btn-label").hidden = false;
      addBtn.querySelector(".spinner").hidden = true;
    }
  }

  async function removePlugin(id, name) {
    if (!confirm('Remove "' + name + '"? Its addon URL will stop working.'))
      return;
    const res = await api("api/plugins/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || "Remove failed", "error");
      return;
    }
    toast("Removed " + name);
    await load();
  }

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    // repo.json URL -> browse the repository; anything else -> install
    if (/\/repo\.json$/i.test(url)) loadRepo(url);
    else addPlugin(url);
  });

  // ---- repository: repo.json plugins render into the main grid ----

  // status + catalogs come from the plugin's manifest URL. Repo entries that
  // point at .sky bundles (zips, not manifests) can't be probed — show them
  // as "Available" with the repo's own categories.
  async function probeRepoPlugin(rp) {
    rp.catalogs = (rp.categories || []).map((c) => ({ name: c }));
    if (/\.sky$/i.test(rp.url)) {
      rp.status = "available";
      rp.error = "";
      return;
    }
    rp.status = "error";
    rp.error = "manifest fetch failed";
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(rp.url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json"))
        throw new Error(
          "not a manifest (" + (ct || "unknown content type") + ")",
        );
      const m = await res.json();
      rp.status = "live";
      rp.catalogs = Array.isArray(m.catalogs)
        ? m.catalogs.map((c) => ({ name: c.name || c.id || "catalog" }))
        : [];
    } catch (e) {
      rp.status = "error";
      rp.error =
        e.name === "AbortError" ? "manifest fetch timed out" : e.message;
    }
  }

  async function loadRepo(url) {
    addBtn.disabled = true;
    addBtn.querySelector(".btn-label").hidden = true;
    addBtn.querySelector(".spinner").hidden = false;
    addError.hidden = true;
    try {
      const res = await api("api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      const list = data.plugins || [];
      repoInfo.textContent =
        "Repository \u201c" +
        (data.name || "?") +
        "\u201d loaded \u2014 probing " +
        list.length +
        " plugin manifests\u2026";
      repoInfo.hidden = false;
      await Promise.all(list.map(probeRepoPlugin));
      repoPluginList = list;
      urlInput.value = "";
      repoInfo.textContent =
        "Repository \u201c" +
        (data.name || "?") +
        "\u201d \u2014 " +
        repoPluginList.length +
        " plugins below.";
      toast("Repo loaded: " + repoPluginList.length + " plugins");
      // load() skips re-render when the plugin list didn't change — force it
      // so the repo's cards show up in the grid
      lastJson = "";
      await load();
    } catch (e) {
      addError.textContent = e.message;
      addError.hidden = false;
    } finally {
      addBtn.disabled = false;
      addBtn.querySelector(".btn-label").hidden = false;
      addBtn.querySelector(".spinner").hidden = true;
    }
  }

  // "Install in Stremio" on a repo card: install it first, then open Stremio
  async function installRepoPlugin(url, name) {
    try {
      const res = await api("api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      toast("Installed " + data.plugin.name);
      window.location.href = stremioInstallUrl(url);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // Remove from the repo list; uninstall too if it was installed
  async function removeRepoPlugin(url, name) {
    if (!confirm('Remove "' + name + '" from the repository list?')) return;
    repoPluginList = repoPluginList.filter((p) => p.url !== url);
    selected.delete("repo:" + url);
    const installed = lastPlugins.find((p) => p.url === url);
    if (installed) {
      await api("api/plugins/" + encodeURIComponent(installed.id), {
        method: "DELETE",
      });
      toast("Removed " + name);
      lastJson = "";
      await load();
    } else {
      render(lastPlugins);
    }
  }

  function selectAll() {
    for (const p of lastPlugins) selected.add(p.id);
    for (const rp of repoPluginList) selected.add("repo:" + rp.url);
    render(lastPlugins);
  }

  function removeAll() {
    selected.clear();
    render(lastPlugins);
  }

  async function resetAll() {
    // wipe everything: installed plugins, selection, repo list — fresh start
    const ids = lastPlugins.map((p) => p.id);
    const del = ids.map((id) =>
      fetch(`/api/plugins/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }).then((r) => r.ok),
    );
    await Promise.allSettled(del);
    selected.clear();
    repoPluginList = [];
    repoInfo.hidden = true;
    lastJson = "";
    updateSelBar();
    await load();
    toast(
      ids.length
        ? "Reset \u2014 all plugins removed"
        : "Reset \u2014 fresh start",
    );
  }

  grid.addEventListener("click", (e) => {
    const tgl = e.target.closest(".toggle");
    if (tgl) {
      const key = tgl.dataset.toggle;
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      tgl.classList.toggle("on", selected.has(key));
      tgl.setAttribute("aria-pressed", selected.has(key));
      tgl.closest(".card").classList.toggle("card-selected", selected.has(key));
      updateSelBar();
      return;
    }
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      copyText(copyBtn.dataset.copy).then(() => toast("Link copied"));
      return;
    }
    const instBtn = e.target.closest("[data-install]");
    if (instBtn) {
      const name = instBtn.closest(".card").querySelector("h3").textContent;
      installRepoPlugin(instBtn.dataset.install, name);
      return;
    }
    const rmBtn = e.target.closest("[data-remove]");
    if (rmBtn) {
      const card = rmBtn.closest(".card");
      const name = card.querySelector("h3").textContent;
      const key = rmBtn.dataset.remove;
      if (key.startsWith("repo:")) removeRepoPlugin(key.slice(5), name);
      else removePlugin(key, name);
    }
  });

  bundleList.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-bcopy]");
    if (copyBtn) {
      copyText(copyBtn.dataset.bcopy).then(() => toast("Link copied"));
      return;
    }
    const delBtn = e.target.closest("[data-bdel]");
    if (delBtn) deleteBundle(delBtn.dataset.bdel);
  });

  selectAllBtn.addEventListener("click", selectAll);
  removeAllBtn.addEventListener("click", removeAll);
  resetBtn.addEventListener("click", resetAll);
  makeBundle.addEventListener("click", createBundle);
  bundleResultCopy.addEventListener("click", () =>
    copyText(bundleResultUrl.textContent).then(() => toast("Link copied")),
  );
  bundleResultCopyBtn.addEventListener("click", () =>
    copyText(bundleResultUrl.textContent).then(() => toast("Link copied")),
  );
  bundleResultClose.addEventListener("click", () => {
    bundleResult.hidden = true;
  });

  // keep statuses fresh (a plugin can recover or error at any time)
  setInterval(() => load().catch(() => {}), 30000);

  load().catch((e) => {
    toast("Failed to load plugins: " + e.message, "error");
  });
  loadBundles().catch(() => {});
})();
