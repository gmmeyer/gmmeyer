// Web Worker for the demo: Pyodide (CPython 3.14 in WebAssembly) compiles the
// script and runs the harness (bcvm.web); the model runs on ONNX Runtime Web,
// on WebGPU when it passes a self-test, else on the CPU (WASM).
//
// In:  {type: "init", config}  {type: "run", src}  {type: "pause"}  {type: "resume"}
//      {type: "stop"}  {type: "delay", ms}
// Out: {type: "status", text}  {type: "ready", backend}  {type: "start", ...}
//      {type: "step", ...}  {type: "done", ...}  {type: "error", text}
import { StepModel } from "./model.js";

let py, model, delayMs = 0, paused = null, stopped = false;
const post = (type, data = {}) => self.postMessage({ type, ...data });

async function fetchCached(url, label, version) {
  // Cache Storage keeps the model across visits, under a name that changes
  // with the model (its sha256 from the .json); older copies are deleted.
  let cache = null;
  if ("caches" in self) {
    const name = `pythonlm-${version}`;
    for (const old of await caches.keys()) if (old.startsWith("pythonlm-") && old !== name) await caches.delete(old);
    cache = await caches.open(name);
  }
  const hit = cache && (await cache.match(url));
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (Date.now() - last > 200) {
      last = Date.now();
      post("status", { text: `${label}: ${(got / 1e6).toFixed(0)}${total ? ` of ${(total / 1e6).toFixed(0)}` : ""} MB` });
    }
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  if (cache) await cache.put(url, new Response(bytes));
  return bytes;
}

async function selftest(m, meta) {
  for (const c of meta.selftest) {
    await m.prefill(c.listing);
    const all = new Uint8Array(c.step.length * meta.vocab_size).fill(1);
    const got = await m.forward(c.step, all);
    if (c.expect.some((t, j) => got[c.start + j] !== t)) return false;
  }
  return true;
}

// Milliseconds per forward pass of the kind a run makes: a few tokens at a time
// after a listing (after one untimed pass, which compiles WebGPU's shaders).
async function speed(m, meta) {
  const c = meta.selftest.reduce((a, b) => (b.step.length > a.step.length ? b : a));   // 39+ tokens
  const all = new Uint8Array(3 * meta.vocab_size).fill(1);
  await m.prefill(c.listing);
  await m.forward(c.step.slice(0, 3), all);
  const t0 = performance.now();
  for (let i = 1; i <= 12; i++) await m.forward(c.step.slice(3 * i, 3 * i + 3), all);
  return (performance.now() - t0) / 12;
}

async function init(config) {
  post("status", { text: "Loading Python 3.14 (Pyodide)…" });
  const { loadPyodide } = await import(config.pyodide + "pyodide.mjs");
  py = await loadPyodide({ indexURL: config.pyodide });
  const runtime = await (await fetch(config.runtime)).arrayBuffer();
  py.unpackArchive(runtime, "zip", { extractDir: "/lib/pythonlm" });
  py.runPython("import sys; sys.path.insert(0, '/lib/pythonlm')");

  // the webgpu bundle (JS kernels): the "all" bundle's WebGPU backend computed
  // this model wrongly in Chrome 152 (logits off by ~25), while this one matches
  // the CPU to 1e-5; the self-test below checks whichever runs
  const ort = await import(config.ort + "ort.webgpu.bundle.min.mjs");
  ort.env.wasm.wasmPaths = config.ort;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const meta = await (await fetch(config.model + "pythonlm.json", { cache: "no-cache" })).json();
  const bytes = await fetchCached(config.model + "pythonlm.onnx", "Downloading the model", (meta.onnx_sha256 || "dev").slice(0, 16));

  // Each backend must reproduce the reference answers; of those that do, the
  // faster one on the self-test wins (a model this small is often faster on
  // the CPU than through WebGPU's per-kernel overhead). ?backend= forces one.
  const wanted = config.backend === "auto" ? ["webgpu", "wasm"] : [config.backend];
  const tried = [];
  for (const ep of wanted) {
    if (ep === "webgpu" && !self.navigator.gpu) { tried.push("no WebGPU in this browser"); continue; }
    post("status", { text: `Checking the model on ${ep === "webgpu" ? "your GPU" : "your CPU"}…` });
    try {
      const m = await StepModel.load(ort, bytes, meta, { executionProviders: [ep] });
      const ok = await selftest(m, meta);
      const ms = ok ? await speed(m, meta) : Infinity;
      tried.push(`${ep}: ${ok ? `${ms.toFixed(1)} ms per pass` : "wrong answers"}`);
      if (ok && (!model || ms < model.ms)) model = Object.assign(m, { ep, ms });
    } catch (e) {
      tried.push(`${ep}: ${e.message || e}`);
    }
  }
  if (!model) throw new Error(`the model failed its self-test in this browser (${tried.join("; ")})`);
  py.globals.set("js_model", model);
  py.runPython(RUNNER);
  post("ready", { backend: model.ep, note: `self-test: ${tried.join("; ")}` });
}

// Python side of a run: refusals, the reference output (real CPython's, via
// exec, once the reference interpreter shows the script finishes), then the
// model, posting each step.
const RUNNER = `
import contextlib, io, json, time
from bcvm import refvm, support, web
from bcvm.program import Program, CompileError
from bcvm.values import LimitExceeded, PyError, Unsupported

MODEL = web.JsModel(js_model)

async def run_script(src, bridge):
    try:
        prog = Program(src)
        support.check(prog, "C")
    except (support.Refusal, CompileError) as e:
        bridge.post("done", json.dumps({"refused": str(e)}))
        return
    try:
        trace = refvm.run(prog, 10_000)
    except LimitExceeded as e:
        bridge.post("done", json.dumps({"refused": f"too long for the demo: {e}"}))
        return
    except Unsupported as e:
        bridge.post("done", json.dumps({"refused": str(e)}))
        return
    if trace.error is not None:
        bridge.post("done", json.dumps({"refused": f"this script raises {trace.error.exc_type}, and exceptions aren't supported yet"}))
        return
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        exec(compile(src, "<script>", "exec"), {})
    bridge.post("start", json.dumps({"listing": web.listing_view(prog), "python": out.getvalue(), "steps": trace.steps}))

    stats, t0 = web.Stats(), time.time()
    async def on_step(i, st, printed):
        bridge.post("step", json.dumps({"i": i, "printed": printed, **web.state_view(prog, st)}))
        await bridge.pace()
    try:
        res = await web.run(src, "C", MODEL, max_steps=2 * trace.steps + 100, on_step=on_step, stats=stats)
    except Exception as e:
        if "stopped" in str(e):
            bridge.post("done", json.dumps({"stopped": True}))
            return
        raise
    bridge.post("done", json.dumps({
        "stdout": res.stdout, "error": res.error, "steps": res.steps, "match": res.stdout == trace.stdout and not res.error,
        "seconds": time.time() - t0, "forwards": stats.forwards, "rescued": res.rescued}))
`;

const bridge = {
  post: (type, json) => post(type, JSON.parse(json)),
  pace: async () => {
    if (stopped) throw new Error("stopped");
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (paused) await paused.promise;
    if (stopped) throw new Error("stopped");
  },
};

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") await init(data.config);
    else if (data.type === "run") {
      stopped = false;
      await py.globals.get("run_script")(data.src, bridge);
    } else if (data.type === "delay") delayMs = data.ms;
    else if (data.type === "pause") {
      let resolve;
      paused = { promise: new Promise((r) => (resolve = r)), resolve };
    } else if (data.type === "resume") {
      paused?.resolve();
      paused = null;
    } else if (data.type === "stop") {
      stopped = true;
      paused?.resolve();
      paused = null;
    }
  } catch (e) {
    post("error", { text: String(e.message || e) });
  }
};
