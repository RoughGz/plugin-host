// Plugin host: worker lifecycle, call timeout with kill/respawn, result normalization.
const { Worker } = require("node:worker_threads");
const path = require("node:path");

const CALL_TIMEOUT_MS = parseInt(process.env.CALL_TIMEOUT_MS || "25000", 10);

class PluginRuntime {
  constructor(name, code, manifest, defaults) {
    this.name = name;
    this.lastParams = { code, manifest, defaults };
    this.api = [];
    this.loadError = null;
    this.dead = false;
    this.seq = 0;
    this.pending = new Map();
    this.worker = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.spawn();
  }

  spawn() {
    const { code, manifest, defaults } = this.lastParams;
    this.dead = false;
    this.loadError = null;
    const w = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { code, manifest, defaults },
    });
    this.worker = w;
    this.readyPromise = new Promise((res) => {
      this.readyResolve = res;
    });
    w.on("message", (m) => {
      if (m.type === "ready") {
        this.api = m.api || [];
        this.loadError = m.error || null;
        this.readyResolve();
      } else if (m.type === "result") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (p) p(m);
      }
    });
    w.on("error", () => this.handleDeath());
    w.on("exit", (code2) => {
      if (this.readyPromise && !this.dead && code2 !== 0) this.handleDeath();
    });
  }

  handleDeath() {
    this.dead = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p({ ok: false, error: "plugin worker died" });
    if (this.worker) this.worker.terminate().catch(() => {});
  }

  async call(fn, args) {
    if (this.dead) this.spawn(); // respawn lazily after a kill
    await this.readyPromise;
    if (this.dead) this.spawn();
    if (this.loadError)
      return { ok: false, error: "plugin load error: " + this.loadError };
    const id = ++this.seq;
    let resolveCall;
    const result = new Promise((res) => {
      resolveCall = res;
    });
    this.pending.set(id, resolveCall);
    this.worker.postMessage({ type: "call", id, fn, args: args || [] });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.handleDeath(); // hung (e.g. infinite loop) — kill, respawn on next call
      resolveCall({
        ok: false,
        error: "timeout after " + CALL_TIMEOUT_MS + "ms",
      });
    }, CALL_TIMEOUT_MS);
    const m = await result;
    clearTimeout(timer);
    return m;
  }

  destroy() {
    this.dead = true;
    if (this.worker) this.worker.terminate().catch(() => {});
  }
}

function normalizeResult(value) {
  if (value === undefined || value === null || value === "__dart_void__")
    return { success: true, data: undefined };
  if (typeof value === "object" && !Array.isArray(value)) {
    if (value.success === false)
      return {
        success: false,
        message:
          value.message || value.error || value.errorCode || "plugin error",
      };
    if (value.success === true) return { success: true, data: value.data };
  }
  return { success: true, data: value };
}

async function callPlugin(plugin, fn, args) {
  const m = await plugin.call(fn, args);
  if (!m.ok)
    return { success: false, message: m.error || "plugin call failed" };
  return normalizeResult(m.value);
}

module.exports = {
  PluginRuntime,
  callPlugin,
  normalizeResult,
  CALL_TIMEOUT_MS,
};
