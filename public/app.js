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
  const installRoot = $("#installRoot");
  const copyManifest = $("#copyManifest");
  const selBar = $("#selBar");
  const selCount = $("#selCount");
  const makeBundle = $("#makeBundle");
  const bundleResult = $("#bundleResult");
  const bundleResultUrl = $("#bundleResultUrl");
  const bundleResultInstall = $("#bundleResultInstall");
  const bundleResultCopy = $("#bundleResultCopy");
  const bundleResultCopyBtn = $("#bundleResultCopyBtn");
  const bundleResultClose = $("#bundleResultClose");
  const bundlesSection = $("#bundlesSection");
  const bundleCount = $("#bundleCount");
  const bundleList = $("#bundleList");
  const selected = new Set();

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

  function render(plugins) {
    grid.innerHTML = "";
    empty.hidden = plugins.length > 0;
    stats.hidden = plugins.length === 0;
    statPlugins.textContent = plugins.length;
    statCatalogs.textContent = plugins.reduce(
      (n, p) => n + p.catalogs.length,
      0,
    );
    statLive.textContent = plugins.filter((p) => p.status !== "error").length;
    for (const id of selected)
      if (!plugins.some((p) => p.id === id)) selected.delete(id);
    updateSelBar();

    for (const p of plugins) {
      const card = document.createElement("article");
      card.className = "card" + (p.status === "error" ? " card-error" : "");
      card.innerHTML = `
        <div class="card-head">
          <div class="card-title">
            <input type="checkbox" class="card-check" data-check="${esc(p.id)}" title="Select for a bundle" aria-label="Select ${esc(p.name)}" ${selected.has(p.id) ? "checked" : ""}>
            <h3>${esc(p.name)}</h3>
            <span class="status status-${p.status === "error" ? "error" : "live"}">
              ${p.status === "error" ? "Error" : "Live"}
            </span>
          </div>
          <button class="icon-btn" data-remove="${esc(p.id)}" title="Remove plugin" aria-label="Remove ${esc(p.name)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
        ${p.status === "error" ? `<p class="card-error-msg">${esc(p.error)}</p>` : ""}
        <div class="chips">
          ${
            p.catalogs.length
              ? p.catalogs
                  .map((c) => `<span class="chip">${esc(c.name)}</span>`)
                  .join("")
              : '<span class="chip chip-muted">no catalogs</span>'
          }
        </div>
        <div class="url-row">
          <code class="url" title="${esc(p.addonUrl)}">${esc(p.addonUrl)}</code>
          <button class="icon-btn" data-copy="${esc(p.addonUrl)}" title="Copy addon URL" aria-label="Copy addon URL">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
        </div>
        <div class="card-actions">
          <a class="btn btn-primary btn-sm" href="${esc(stremioInstallUrl(p.addonUrl))}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
            Install in Stremio
          </a>
          <button class="btn btn-ghost btn-sm" data-copy="${esc(p.addonUrl)}">Copy link</button>
        </div>`;
      grid.appendChild(card);
    }
  }

  let lastJson = "";
  function updateSelBar() {
    selBar.hidden = selected.size === 0;
    selCount.textContent =
      selected.size +
      (selected.size === 1 ? " plugin selected" : " plugins selected");
  }

  async function createBundle() {
    if (!selected.size) return;
    makeBundle.disabled = true;
    try {
      const res = await api("api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginIds: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      showBundleResult(data.bundle.url);
      selected.clear();
      updateSelBar();
      for (const cb of grid.querySelectorAll(".card-check")) cb.checked = false;
      await loadBundles();
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

  // ---- repository browser (inline in the add card) ----
  const repoError = $("#addError");
  const repoResult = $("#repoResult");
  const repoName = $("#repoName");
  const repoDesc = $("#repoDesc");
  const repoPlugins = $("#repoPlugins");
  const repoAddSelected = $("#repoAddSelected");
  let repoPluginList = [];

  async function loadRepo(url) {
    addBtn.disabled = true;
    addBtn.querySelector(".btn-label").hidden = true;
    addBtn.querySelector(".spinner").hidden = false;
    repoError.hidden = true;
    repoResult.hidden = true;
    try {
      const res = await api("api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      repoPluginList = data.plugins || [];
      repoName.textContent = data.name;
      repoDesc.textContent = data.description || "";
      repoPlugins.innerHTML = "";
      for (const p of repoPluginList) {
        const row = document.createElement("label");
        row.className = "repo-plugin";
        row.innerHTML =
          '<input type="checkbox" class="repo-check" data-repo="' +
          p.url.replace(/"/g, "&quot;") +
          '">' +
          '<div><div class="rp-name">' +
          esc(p.name) +
          "</div>" +
          (p.description
            ? '<div class="rp-desc">' + esc(p.description) + "</div>"
            : "") +
          (p.categories.length
            ? '<div class="rp-cats">' +
              p.categories.map((c) => "<span>" + esc(c) + "</span>").join("") +
              "</div>"
            : "") +
          "</div>";
        repoPlugins.appendChild(row);
      }
      repoResult.hidden = false;
      updateRepoAddBtn();
    } catch (e) {
      repoError.textContent = e.message;
      repoError.hidden = false;
    } finally {
      addBtn.disabled = false;
      addBtn.querySelector(".btn-label").hidden = false;
      addBtn.querySelector(".spinner").hidden = true;
    }
  }

  function updateRepoAddBtn() {
    const any = repoPlugins.querySelector(".repo-check:checked");
    repoAddSelected.disabled = !any;
  }

  repoPlugins.addEventListener("change", updateRepoAddBtn);

  repoAddSelected.addEventListener("click", async () => {
    const urls = [...repoPlugins.querySelectorAll(".repo-check:checked")].map(
      (cb) => cb.dataset.repo,
    );
    if (!urls.length) return;
    repoAddSelected.disabled = true;
    const names = new Map(repoPluginList.map((p) => [p.url, p.name]));
    let ok = 0;
    const errors = [];
    for (const url of urls) {
      try {
        const res = await api("api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, name: names.get(url) || "" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        ok++;
      } catch (e) {
        errors.push(names.get(url) || url + ": " + e.message);
      }
    }
    if (ok) toast("Added " + ok + " plugin" + (ok > 1 ? "s" : ""));
    if (errors.length) toast("Failed: " + errors.join(" | "), "error");
    repoAddSelected.disabled = false;
    await load();
  });

  grid.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      copyText(copyBtn.dataset.copy).then(() => toast("Link copied"));
      return;
    }
    const rmBtn = e.target.closest("[data-remove]");
    if (rmBtn) {
      const card = rmBtn.closest(".card");
      const name = card.querySelector("h3").textContent;
      removePlugin(rmBtn.dataset.remove, name);
    }
  });

  grid.addEventListener("change", (e) => {
    const cb = e.target.closest(".card-check");
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.check);
    else selected.delete(cb.dataset.check);
    updateSelBar();
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

  installRoot.addEventListener("click", () => {
    window.open(stremioInstallUrl(location.origin + "/manifest.json"), "_self");
  });

  copyManifest.addEventListener("click", () => {
    copyText(location.origin + "/manifest.json").then(() =>
      toast("Manifest URL copied"),
    );
  });

  // keep statuses fresh (a plugin can recover or error at any time)
  setInterval(() => load().catch(() => {}), 30000);

  load().catch((e) => {
    toast("Failed to load plugins: " + e.message, "error");
  });
  loadBundles().catch(() => {});
})();
