const { Worker } = require("node:worker_threads");
const path = require("node:path");
const v8 = require("node:v8");

// Block the vm-sandbox escape `Buffer.constructor("return process")()`: plugin
// code still compiles via vm.runInContext (vm-internal eval/Function work), but
// host-realm Function can no longer compile from strings. Workers inherit the
// flag; vm is NOT a security boundary on its own (see README).
try {
  v8.setFlagsFromString("--disallow-code-generation-from-strings");
} catch (e) {
  // old Node may reject runtime flag changes; vm isolation alone still applies
}

const CALL_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.CALL_TIMEOUT_MS || "25000", 10);
  return Number.isFinite(n) && n > 0 ? n : 25000;
})();

class PluginRuntime {
  constructor(name, code, manifest, defaults) {
    this.name = name;
    this.lastParams = { code, manifest, defaults };
    this.api = [];
    this.loadError = null;
    this.dead = false;
    this.destroyed = false;
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
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
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
    // ignore events from stale workers (a respawned worker's old exit must not
    // kill the new one)
    w.on("error", () => {
      if (this.worker === w) this.handleDeath();
    });
    w.on("exit", () => {
      if (this.worker === w && !this.dead) this.handleDeath();
    });
  }

  handleDeath() {
    if (this.destroyed) return;
    this.dead = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    if (this.readyResolve) this.readyResolve(); // unblock awaiting calls; they re-check dead
    for (const p of pending) p({ ok: false, error: "plugin worker died" });
    if (this.worker) this.worker.terminate().catch(() => {});
  }

  async call(fn, args) {
    if (this.destroyed) return { ok: false, error: "plugin destroyed" };
    if (this.dead) this.spawn(); // respawn lazily after a kill
    await this.readyPromise;
    if (this.destroyed) return { ok: false, error: "plugin destroyed" };
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.dead = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    if (this.readyResolve) this.readyResolve();
    for (const p of pending) p({ ok: false, error: "plugin destroyed" });
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
};
