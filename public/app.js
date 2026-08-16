// Plugin Host dashboard — vanilla JS, no dependencies.
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const grid = $("#grid");
  const empty = $("#empty");
  const count = $("#count");
  const addForm = $("#addForm");
  const urlInput = $("#urlInput");
  const addBtn = $("#addBtn");
  const addError = $("#addError");
  const toasts = $("#toasts");
  const installAll = $("#installAll");

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
    count.hidden = plugins.length === 0;
    count.textContent =
      plugins.length + (plugins.length === 1 ? " plugin" : " plugins");
    installAll.hidden = plugins.length === 0;

    for (const p of plugins) {
      const card = document.createElement("article");
      card.className = "card" + (p.status === "error" ? " card-error" : "");
      card.innerHTML = `
        <div class="card-head">
          <div class="card-title">
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

  async function load() {
    const res = await api("/api/plugins");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    render(data.plugins || []);
  }

  async function addPlugin(url) {
    addBtn.disabled = true;
    addBtn.querySelector(".btn-label").hidden = true;
    addBtn.querySelector(".spinner").hidden = false;
    addError.hidden = true;
    try {
      const res = await api("/api/plugins", {
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
    const res = await api("/api/plugins/" + encodeURIComponent(id), {
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
    if (url) addPlugin(url);
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

  installAll.addEventListener("click", () => {
    window.open(stremioInstallUrl(location.origin + "/manifest.json"), "_self");
  });

  load().catch((e) => {
    toast("Failed to load plugins: " + e.message, "error");
  });
})();
